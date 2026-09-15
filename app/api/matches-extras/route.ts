import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import type { MatchExtras } from '@/hooks/useMatchExtras';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { parseMatchExtrasPayload } from '@/lib/db/planning-payload-codecs';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const repo = db.getRepository('MatchExtra');
    const rows = await repo.findBy({ clubId: auth.user.clubId });
    const extras: Record<string, MatchExtras> = {};

    for (const row of rows) {
      extras[String(row.matchId)] = parseMatchExtrasPayload(row.payload, row.matchId);
    }

    return NextResponse.json(extras);
  } catch (error) {
    logError('app.unhandled', 'Erreur GET all match extras:', error);
    return NextResponse.json({ error: 'Erreur lors de la récupération des informations' }, { status: 500 });
  }
}
