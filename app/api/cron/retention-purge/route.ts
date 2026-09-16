import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { listActiveClubIds } from '@/lib/db/club-tenants';
import { runRetentionPurge } from '@/lib/retention/purge';
import { logError, logInfo } from '@/lib/observability/log';

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

  const dryRun = new URL(request.url).searchParams.get('dryRun') === 'true';

  try {
    const db = await getDb();
    const clubIds = await listActiveClubIds(db);
    const report = await runRetentionPurge(db, { dryRun, clubIds });
    logInfo('app.unhandled', 
      '[retention-purge]',
      dryRun ? 'dry-run' : 'applied',
      `success=${report.success}`,
      `failed=${report.failedCategories.join(',') || 'none'}`,
      `categories=${report.categories.length}`,
    );
    return NextResponse.json(report, { status: report.success ? 200 : 500 });
  } catch (error) {
    logError('app.unhandled', '[retention-purge] job failed', error instanceof Error ? error.name : 'error');
    return NextResponse.json({ error: 'Retention purge cron failed' }, { status: 500 });
  }
}
