import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { readAppSettings } from '@/lib/settings-store';
import { roleLabelWithClub } from '@/lib/settings';
import { EXPORT_CACHE_HEADERS, exportColumnLabels } from '@/lib/planning/export';
import { listExportSnapshots, projectExportRows } from '@/lib/planning/export-query';
import { consumeExportDownload } from '@/lib/planning/export-download';
import { exportFileResponse, renderExportBody } from '@/lib/planning/export-render';
import { logError } from '@/lib/observability/log';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const { token } = await context.params;
  if (!token || token.length < 16) {
    return NextResponse.json({ error: 'Lien de téléchargement invalide' }, { status: 404, headers: { ...EXPORT_CACHE_HEADERS } });
  }

  try {
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'massExport');
    if (disabled) return disabled;

    const payload = await consumeExportDownload(db, token, auth.user.clubId);
    if (!payload) {
      return NextResponse.json({ error: 'Lien de téléchargement invalide ou expiré' }, { status: 404, headers: { ...EXPORT_CACHE_HEADERS } });
    }

    const settings = await readAppSettings(db, auth.user.clubId);
    const snapshots = await listExportSnapshots(db, auth.user.clubId, {
      eventTypes: payload.eventTypes,
      fromDate: payload.fromDate,
      toDate: payload.toDate,
      includeDrafts: payload.includeDrafts,
      settings,
    });
    const rows = projectExportRows(snapshots, payload.columns, payload.includePhones);
    const labels = exportColumnLabels(settings.clubAbbreviation, roleLabelWithClub);
    return exportFileResponse(renderExportBody({
      format: payload.format,
      columns: payload.columns,
      rows,
      labels,
      clubName: settings.clubName,
    }));
  } catch (error) {
    logError('app.unhandled', 'Planning export download failed:', error);
    return NextResponse.json({ error: 'Impossible d’exporter le planning' }, { status: 500 });
  }
}
