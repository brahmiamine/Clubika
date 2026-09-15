import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { hasAnyPlanningFunction } from '@/lib/auth/roles';
import { normalizeIndisponibilites } from '@/lib/utils/officiel-availability';
import { mergePersonalIndisponibilites } from '@/lib/indisponibilites/review';
import { notifyAdmins } from '@/lib/notifications/service';
import type { UserEntity } from '@/lib/db/schemas';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  if (!hasAnyPlanningFunction(auth.user.planningFunctions)) {
    return NextResponse.json({ error: 'Compte personnel non lié' }, { status: 403 });
  }

  return NextResponse.json({ indisponibilites: normalizeIndisponibilites(auth.user.indisponibilites) });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  if (!hasAnyPlanningFunction(auth.user.planningFunctions)) {
    return NextResponse.json({ error: 'Compte personnel non lié' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const db = await getDb();
    const userRepo = db.getRepository<UserEntity>('User');
    const user = await userRepo.findOneBy({ id: auth.user.id });
    if (!user) return NextResponse.json({ error: 'Utilisateur introuvable' }, { status: 404 });

    const indisponibilites = mergePersonalIndisponibilites(normalizeIndisponibilites(user.indisponibilites), body.indisponibilites);
    user.indisponibilites = indisponibilites;
    await userRepo.save(user);

    await notifyAdmins(db, {
      type: 'availability-updated',
      title: 'Indisponibilités mises à jour',
      message: `${auth.user.nom} a mis à jour ses indisponibilités.`,
      eventType: 'indisponibilite',
      eventId: String(auth.user.id),
    });

    return NextResponse.json({ success: true, indisponibilites });
  } catch (error) {
    logError('app.unhandled', 'Error updating personal availability:', error);
    return NextResponse.json({ error: 'Impossible de mettre à jour vos indisponibilités' }, { status: 500 });
  }
}
