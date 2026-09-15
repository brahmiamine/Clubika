import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { flattenClubIndisponibilites } from '@/lib/indisponibilites/club-listing';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const users = await db.getRepository<UserEntity>('User').find({
      where: { clubId: auth.user.clubId },
      order: { nom: 'ASC' },
    });

    return NextResponse.json({ items: flattenClubIndisponibilites(users) });
  } catch (error) {
    logError('app.unhandled', 'Error listing club indisponibilites:', error);
    return NextResponse.json({ error: 'Impossible de charger les indisponibilités' }, { status: 500 });
  }
}
