import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { readAppSettings } from '@/lib/settings-store';
import {
  ExportColumnError,
  EXPORT_CACHE_HEADERS,
  resolveExportColumns,
} from '@/lib/planning/export';
import { listExportSnapshots, normalizeExportEventTypes, projectExportRows } from '@/lib/planning/export-query';
import {
  buildExportDownloadToken,
  pseudonymExportActor,
  saveExportAudit,
  saveExportDownload,
  type ExportDownloadFormat,
} from '@/lib/planning/export-download';

function parseFormat(value: unknown): ExportDownloadFormat {
  return value === 'html' ? 'html' : value === 'json' ? 'json' : 'csv';
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'massExport');
    if (disabled) return disabled;

    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const resolved = resolveExportColumns({
      columns: body.columns,
      includeIdentities: body.includeIdentities,
      includePhones: body.includePhones,
      purpose: body.purpose,
    });
    const eventTypes = normalizeExportEventTypes(body.eventTypes);
    const includeDrafts = body.includeDrafts === true || body.includeDrafts === '1';
    const fromDate = typeof body.fromDate === 'string' ? body.fromDate : null;
    const toDate = typeof body.toDate === 'string' ? body.toDate : null;
    const format = parseFormat(body.format);

    const settings = await readAppSettings(db, auth.user.clubId);
    const snapshots = await listExportSnapshots(db, auth.user.clubId, {
      eventTypes,
      fromDate,
      toDate,
      includeDrafts,
      settings,
    });
    const rows = projectExportRows(snapshots, resolved.ids, resolved.includePhones);
    const { token, expiresAt } = buildExportDownloadToken();

    await saveExportDownload(db, {
      clubId: auth.user.clubId,
      ownerUserId: auth.user.id,
      token,
      payload: {
        format,
        columns: resolved.ids,
        eventTypes,
        fromDate,
        toDate,
        includeDrafts,
        includeIdentities: resolved.includeIdentities,
        includePhones: resolved.includePhones,
        purpose: resolved.purpose,
        expiresAt,
        rowCount: rows.length,
      },
    });
    await saveExportAudit(db, {
      clubId: auth.user.clubId,
      payload: {
        actor: pseudonymExportActor(auth.user.clubId, auth.user.id),
        at: new Date().toISOString(),
        format,
        columns: resolved.ids,
        purpose: resolved.purpose,
        rowCount: rows.length,
        includeIdentities: resolved.includeIdentities,
        includePhones: resolved.includePhones,
      },
    });

    return NextResponse.json(
      { token, expiresAt, rowCount: rows.length, format },
      { headers: { ...EXPORT_CACHE_HEADERS } },
    );
  } catch (error) {
    if (error instanceof ExportColumnError) {
      return NextResponse.json({ error: error.message }, { status: 400, headers: { ...EXPORT_CACHE_HEADERS } });
    }
    logError('app.unhandled', 'Planning export failed:', error);
    return NextResponse.json({ error: 'Impossible d’exporter le planning' }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json(
    { error: 'Utilisez POST pour créer un lien de téléchargement authentifié' },
    { status: 405, headers: { Allow: 'POST', ...EXPORT_CACHE_HEADERS } },
  );
}
