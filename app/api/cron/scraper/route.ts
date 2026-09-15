import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { runScraperAndPersistToDb } from '@/lib/scraper/run-scraper';
import { getDb } from '@/lib/db';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { runWithClubId } from '@/lib/auth/club-context';
import { listActiveClubIds } from '@/lib/db/club-tenants';
import { isSportCoricoSyncEnabled, SPORTCORICO_SYNC_DISABLED_MESSAGE } from '@/lib/scraper/sync-gate';

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

  try {
    if (!isSportCoricoSyncEnabled()) {
      return NextResponse.json({
        success: true,
        disabled: true,
        message: SPORTCORICO_SYNC_DISABLED_MESSAGE,
        results: [],
      });
    }

    const db = await getDb();
    const clubIds = await listActiveClubIds(db);
    const results: Array<{ clubId: string; runId?: string; sync?: unknown; disabled?: true; error?: string }> = [];

    for (const clubId of clubIds) {
      await runWithClubId(clubId, async () => {
        const disabled = await planningFeatureGuard(db, 'scraperSync');
        if (disabled) {
          results.push({ clubId, disabled: true });
          return;
        }
        try {
          const result = await runScraperAndPersistToDb(clubId);
          results.push({ clubId, runId: result.runId, sync: result.sync });
        } catch (error) {
          results.push({ clubId, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      });
    }

    return NextResponse.json({
      success: true,
      message: 'Cron scraper executed successfully',
      results,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      { error: 'Cron scraper failed', details: errorMessage },
      { status: 500 },
    );
  }
}
