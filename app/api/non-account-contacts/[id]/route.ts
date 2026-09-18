import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import { parseStatus, upsertContactMeta, markOpposition, inferCategoryFromPlanningFunctions, loadContactMeta } from '@/lib/non-account-contacts/meta';
import { contactLifecycleResponse } from '@/lib/non-account-contacts/referentiel-write';
import { logError } from '@/lib/observability/log';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const resolved = params instanceof Promise ? await params : params;
    const userId = Number.parseInt(resolved.id, 10);
    if (!Number.isFinite(userId)) {
      return NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 });
    }
    const body = await request.json() as { status?: unknown; opposition?: unknown };
    const db = await getDb();
    const user = await db.getRepository<UserEntity>('User').findOneBy({ id: userId, clubId: auth.user.clubId });
    if (!user || hasAccountAccess(user)) {
      return NextResponse.json({ error: 'Fiche sans compte introuvable' }, { status: 404 });
    }

    if (body.opposition === true) {
      user.telephone = null;
      await db.getRepository<UserEntity>('User').save(user);
      await markOpposition(db, user.id);
      const existing = await loadContactMeta(db, user.id);
      if (!existing) {
        await upsertContactMeta(db, {
          userId: user.id,
          clubId: auth.user.clubId,
          category: inferCategoryFromPlanningFunctions(user.planningFunctions),
          provenance: null,
          purpose: 'organisation_planning',
          recordedByUserId: auth.user.id,
          status: 'refused',
        });
        await markOpposition(db, user.id);
      }
      return NextResponse.json({ success: true });
    }

    const status = parseStatus(body.status);
    if (!status) {
      return NextResponse.json({ error: 'Statut requis' }, { status: 400 });
    }
    await upsertContactMeta(db, {
      userId: user.id,
      clubId: auth.user.clubId,
      category: inferCategoryFromPlanningFunctions(user.planningFunctions),
      provenance: null,
      purpose: 'organisation_planning',
      recordedByUserId: auth.user.id,
      status,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    logError('app.unhandled', 'Error updating non-account contact:', error);
    return NextResponse.json({ error: 'Mise à jour impossible' }, { status: 500 });
  }
}
