import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { MatchesData } from '@/types/match';
import { groupMatchesByDate } from '@/lib/db/helpers';
import { getOfficialMatchesMeta } from '@/lib/db/json-migrator';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { parseMatchPayload } from '@/lib/db/planning-payload-codecs';
import { readAppSettings } from '@/lib/settings-store';
import { filterOfficialMatchesForDisplay } from '@/lib/planning/official-match-visibility';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const repo = db.getRepository('MatchOfficial');
    const [rows, meta, settings] = await Promise.all([
      repo.findBy({ clubId: auth.user.clubId }),
      getOfficialMatchesMeta(db, auth.user.clubId),
      readAppSettings(db, auth.user.clubId),
    ]);

    const matches = filterOfficialMatchesForDisplay(
      rows
        .map((row) => parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' }))
        .filter((item) => Boolean(item?.id) && item.sourceStatus !== 'missing'),
      settings,
    );

    const matchesData: MatchesData = {
      club: meta.club,
      url: meta.url,
      scrapedAt: meta.scrapedAt,
      matches: groupMatchesByDate(matches),
    };

    return NextResponse.json(matchesData);
  } catch (error) {
    console.error('Error reading matches from DB:', error);
    return NextResponse.json({ error: 'Failed to load matches' }, { status: 500 });
  }
}
