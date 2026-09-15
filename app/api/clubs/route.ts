import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';

export interface Club {
  nom: string;
  logo: string;
}

export interface ClubsData {
  clubs: Club[];
}

// Lecture seule : la gestion (ajout/modification/suppression) des clubs adverses
// et de leurs logos se fait désormais depuis /plateforme, par club (voir
// app/api/plateforme/clubs/[id]/opponent-clubs/route.ts).
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const repo = db.getRepository('Club');
    const rows = await repo.find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    const clubs: Club[] = rows.map((club) => ({ nom: String(club.nom), logo: String(club.logo) }));

    return NextResponse.json({ clubs });
  } catch (error) {
    logError('app.unhandled', 'Error reading clubs from DB:', error);
    return NextResponse.json(
      { error: 'Failed to load clubs' },
      { status: 500 }
    );
  }
}
