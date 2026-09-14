import { NextRequest, NextResponse } from 'next/server';
import { runScraperAndPersistToDb } from '@/lib/scraper/run-scraper';
import { getDb } from '@/lib/db';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { listScraperRuns } from '@/lib/scraper/runs';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const db = await getDb();
  return NextResponse.json({ runs: await listScraperRuns(db, auth.user.clubId) });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const disabled = await planningFeatureGuard(await getDb(), 'scraperSync');
    if (disabled) return disabled;
    const { runId, stderr, sync } = await runScraperAndPersistToDb();

    if (stderr && !stderr.includes('✅')) {
      console.error('Scraper stderr:', stderr);
    }

    return NextResponse.json({
      success: true,
      message: 'Scraping completed successfully',
      runId,
      sync,
    });
  } catch (error) {
    console.error('Error running scraper:', error);
    return NextResponse.json(
      { error: 'Failed to run scraper' },
      { status: 500 }
    );
  }
}
