import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { OffboardingError } from '@/lib/tenant-offboarding/errors';
import { freezeClub, cancelFreeze } from '@/lib/tenant-offboarding/freeze';
import { issueExportToken } from '@/lib/tenant-offboarding/export';
import { setLegalHold, clearLegalHold } from '@/lib/tenant-offboarding/legal-hold';
import { acknowledgeProcessor } from '@/lib/tenant-offboarding/processors';
import { purgeClub } from '@/lib/tenant-offboarding/purge';
import { getOffboardingSnapshot } from '@/lib/tenant-offboarding/status';
import { parseRetentionUntil } from '@/lib/tenant-offboarding/dates';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/tenant-offboarding/constants';

async function resolveClubId(params: Promise<{ id: string }> | { id: string }): Promise<string> {
  const resolved = params instanceof Promise ? await params : params;
  return resolved.id;
}

function jsonError(error: unknown): NextResponse {
  if (error instanceof OffboardingError) {
    return NextResponse.json({ error: error.message, notice: PRIVACY_NO_LEGAL_PROMISE }, { status: error.status });
  }
  console.error('tenant offboarding error:', error);
  return NextResponse.json({ error: 'Impossible de traiter l’offboarding' }, { status: 500 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;
  try {
    const clubId = await resolveClubId(params);
    const db = await getDb();
    return NextResponse.json(await getOffboardingSnapshot(db, clubId));
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;
  try {
    const clubId = await resolveClubId(params);
    const db = await getDb();
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action : '';
    const adminId = auth.admin.id;

    if (action === 'freeze') {
      const tenant = await freezeClub(db, clubId, {
        platformAdminId: adminId,
        retentionUntil: parseRetentionUntil(body.retentionUntil),
      });
      return NextResponse.json({
        success: true,
        notice: PRIVACY_NO_LEGAL_PROMISE,
        snapshot: await getOffboardingSnapshot(db, tenant.id),
      });
    }

    if (action === 'cancel-freeze') {
      await cancelFreeze(db, clubId, adminId);
      return NextResponse.json({
        success: true,
        notice: PRIVACY_NO_LEGAL_PROMISE,
        snapshot: await getOffboardingSnapshot(db, clubId),
      });
    }

    if (action === 'export') {
      const issued = await issueExportToken(db, clubId, adminId);
      return NextResponse.json({
        success: true,
        notice: PRIVACY_NO_LEGAL_PROMISE,
        token: issued.token,
        expiresAt: issued.expiresAt,
        downloadPath: `/api/plateforme/offboarding/exports/${issued.token}`,
      });
    }

    if (action === 'purge') {
      const report = await purgeClub(db, clubId, {
        dryRun: body.dryRun !== false,
        overrideRetention: body.overrideRetention === true,
        confirmClubId: typeof body.confirmClubId === 'string' ? body.confirmClubId : undefined,
        platformAdminId: adminId,
      });
      return NextResponse.json({
        success: report.success,
        notice: PRIVACY_NO_LEGAL_PROMISE,
        report,
        snapshot: await getOffboardingSnapshot(db, clubId),
      });
    }

    if (action === 'legal-hold') {
      await setLegalHold(db, clubId, adminId, {
        motive: String(body.motive ?? ''),
        scope: String(body.scope ?? 'full_tenant'),
        expiresAt: String(body.expiresAt ?? ''),
      });
      return NextResponse.json({
        success: true,
        notice: PRIVACY_NO_LEGAL_PROMISE,
        snapshot: await getOffboardingSnapshot(db, clubId),
      });
    }

    if (action === 'clear-legal-hold') {
      await clearLegalHold(db, clubId, adminId);
      return NextResponse.json({
        success: true,
        notice: PRIVACY_NO_LEGAL_PROMISE,
        snapshot: await getOffboardingSnapshot(db, clubId),
      });
    }

    if (action === 'ack-processor') {
      await acknowledgeProcessor(db, clubId, adminId, String(body.processorId ?? ''), String(body.status ?? ''));
      return NextResponse.json({
        success: true,
        notice: PRIVACY_NO_LEGAL_PROMISE,
        snapshot: await getOffboardingSnapshot(db, clubId),
      });
    }

    return NextResponse.json({ error: 'Action inconnue' }, { status: 400 });
  } catch (error) {
    return jsonError(error);
  }
}
