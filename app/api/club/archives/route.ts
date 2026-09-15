import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { MatchExtraEntity, MatchOfficialEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { parseMatchExtrasPayload, parseMatchPayload } from '@/lib/db/planning-payload-codecs';
import { readAppSettings } from '@/lib/settings-store';
import { toOfficialArchiveRow } from '@/lib/archives/official-matches';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const [rows, extraRows, settings] = await Promise.all([
      db.getRepository<MatchOfficialEntity>('MatchOfficial').findBy({ clubId: auth.user.clubId }),
      db.getRepository<MatchExtraEntity>('MatchExtra').findBy({ clubId: auth.user.clubId }),
      readAppSettings(db, auth.user.clubId),
    ]);
    const extrasById = new Map(extraRows.map((row) => [
      row.matchId,
      parseMatchExtrasPayload(row.payload, row.matchId),
    ]));
    const now = Date.now();
    const items = rows
      .map((row) => toOfficialArchiveRow(
        parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' }),
        extrasById.get(row.id) ?? null,
        settings.timeZone,
        now,
      ))
      .filter((item) => item !== null);

    return NextResponse.json({ items });
  } catch (error) {
    logError('app.unhandled', 'Error listing match archives:', error);
    return NextResponse.json({ error: 'Impossible de charger les archives' }, { status: 500 });
  }
}
