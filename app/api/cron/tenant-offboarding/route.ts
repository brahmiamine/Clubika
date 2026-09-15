import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { cronMayPurge, PRIVACY_NO_LEGAL_PROMISE } from '@/lib/tenant-offboarding/constants';
import { listFrozenClubsDue, purgeClub } from '@/lib/tenant-offboarding/purge';

function safeSecretEquals(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

function hasValidSecret(request: NextRequest): boolean {
  const expectedSecret = process.env.CRON_SECRET?.trim();
  if (!expectedSecret) return false;
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return false;
  const bearer = authorization.slice('Bearer '.length).trim();
  return bearer.length > 0 && safeSecretEquals(bearer, expectedSecret);
}

export async function POST(request: NextRequest) {
  if (!hasValidSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dryRun = request.nextUrl.searchParams.get('dryRun') === '1' || !cronMayPurge();
  try {
    const db = await getDb();
    const clubIds = await listFrozenClubsDue(db);
    const reports = [];
    for (const clubId of clubIds) {
      const report = await purgeClub(db, clubId, {
        dryRun,
        overrideRetention: false,
        confirmClubId: dryRun ? undefined : clubId,
        platformAdminId: null,
      });
      reports.push({ clubId, ...report });
    }
    return NextResponse.json({
      notice: PRIVACY_NO_LEGAL_PROMISE,
      dryRun,
      cronMayPurge: cronMayPurge(),
      clubs: clubIds.length,
      reports,
    });
  } catch (error) {
    console.error('tenant offboarding cron error:', error);
    return NextResponse.json({ error: 'Offboarding cron failed' }, { status: 500 });
  }
}
