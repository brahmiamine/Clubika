import type { EntityManager } from 'typeorm';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { hashPassword } from '@/lib/auth/password';
import { normalizeAccessRole, normalizePlanningFunctions } from '@/lib/auth/roles';
import { revokeAllSessionsForUser } from '@/lib/auth/session';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { hasFuturePlanningAssignments } from '@/lib/planning/person-link';
import { findUserReferences } from '@/lib/planning/user-references';
import { notifyAdmins } from '@/lib/notifications/service';
import { readAppSettings } from '@/lib/settings-store';
import { anonymizeMessagesForDeletedUser } from '@/lib/chat/service';
import { serializeManagedUser } from '@/lib/non-account-contacts/serialize-user';
import { applyTelephoneGateAndMeta, contactLifecycleResponse } from '@/lib/non-account-contacts/referentiel-write';
import { inferCategoryFromPlanningFunctions } from '@/lib/non-account-contacts/meta';

function isMysqlDeadlock(error: unknown): boolean {
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 5; depth += 1) {
    const record = current as { code?: unknown; errno?: unknown; driverError?: unknown };
    if (record.code === 'ER_LOCK_DEADLOCK' || record.errno === 1213) return true;
    current = record.driverError;
  }
  return false;
}

async function retryOnMysqlDeadlock<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      lastError = error;
      if (!isMysqlDeadlock(error) || attempt === attempts) throw error;
    }
  }
  throw lastError;
}

function serializeUser(user: UserEntity) {
  const serialized = serializeManagedUser(user);
  return {
    id: serialized.id,
    email: serialized.email,
    nom: serialized.nom,
    accessRole: serialized.accessRole,
    planningFunctions: serialized.planningFunctions,
    active: serialized.active,
    telephone: serialized.telephone,
    createdAt: serialized.createdAt,
    updatedAt: serialized.updatedAt,
  };
}

function getRepo(db: Awaited<ReturnType<typeof getDb>>) {
  return db.getRepository<UserEntity>('User');
}

/**
 * Verrou pessimiste, en une seule requête et un ordre déterministe (id croissant),
 * sur la ligne ciblée ET sur tous les administrateurs actifs du club (issue #273).
 *
 * Locker les deux ensembles en deux requêtes séparées — d'abord la ligne ciblée,
 * puis (seulement si besoin) l'ensemble des admins — expose à un interblocage :
 * deux requêtes visant chacune un administrateur différent verrouillent d'abord
 * leur propre ligne (déjà incluse dans l'ensemble complet), puis se bloquent
 * mutuellement en tentant de verrouiller la ligne que l'autre détient déjà. Une
 * unique requête, toujours dans le même ordre, élimine cette attente circulaire :
 * la seconde transaction attend l'ensemble complet avant d'avoir elle-même acquis
 * le moindre verrou contesté.
 */
async function lockTargetAndActiveAdmins(
  manager: EntityManager,
  clubId: string,
  targetId: number,
): Promise<UserEntity[]> {
  return manager
    .getRepository<UserEntity>('User')
    .createQueryBuilder('user')
    .setLock('pessimistic_write')
    .where(
      'user.clubId = :clubId AND (user.id = :targetId OR (user.active = :active AND user.accessRole = :role))',
      { clubId, targetId, active: true, role: 'admin' },
    )
    .orderBy('user.id', 'ASC')
    .getMany();
}

type PutOutcome =
  | { kind: 'not-found' }
  | { kind: 'last-admin' }
  | { kind: 'ok'; userId: number; revokeSessions: boolean; notifyDeactivatedWithAssignments: boolean };

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const id = Number.parseInt(resolvedParams.id, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 });
    }

    const body = await request.json();
    const { nom, active, telephone, password } = body;
    if (typeof password === 'string' && password.length > 0 && password.length < 8) {
      return NextResponse.json({ error: 'Le mot de passe doit contenir au moins 8 caractères' }, { status: 400 });
    }

    const db = await getDb();
    const outcome: PutOutcome = await db.transaction(async (manager) => {
      const userRepo = manager.getRepository<UserEntity>('User');
      const locked = await lockTargetAndActiveAdmins(manager, auth.user.clubId, id);
      const user = locked.find((candidate) => candidate.id === id);
      if (!user) return { kind: 'not-found' };

      const nextAccessRole = body.accessRole !== undefined
        ? normalizeAccessRole(body.accessRole)
        : normalizeAccessRole(user.accessRole);
      const nextFunctions = body.planningFunctions !== undefined
        ? normalizePlanningFunctions(body.planningFunctions)
        : normalizePlanningFunctions(user.planningFunctions);
      const nextActive = typeof active === 'boolean' ? active : user.active;

      const wasActive = user.active;
      const wasAdmin = user.accessRole === 'admin';
      const staysAdmin = nextAccessRole === 'admin';
      if (wasAdmin && (!staysAdmin || !nextActive)) {
        const activeAdmins = locked.filter((candidate) => candidate.active && candidate.accessRole === 'admin').length;
        if (activeAdmins <= 1) return { kind: 'last-admin' };
      }

      if (typeof nom === 'string' && nom.trim() !== '') user.nom = nom.trim();
      user.accessRole = nextAccessRole;
      user.planningFunctions = nextFunctions;
      user.active = nextActive;
      if (typeof telephone === 'string') {
        if (user.claimedAt == null) {
          user.telephone = await applyTelephoneGateAndMeta(db, {
            user,
            clubId: auth.user.clubId,
            category: inferCategoryFromPlanningFunctions(user.planningFunctions),
            recordedByUserId: auth.user.id,
            body,
          });
        } else {
          user.telephone = telephone.trim() || null;
        }
      }
      if (typeof password === 'string' && password.length > 0) {
        user.passwordHash = await hashPassword(password);
      }
      await userRepo.save(user);

      return {
        kind: 'ok',
        userId: user.id,
        revokeSessions: !user.active || (typeof password === 'string' && password.length > 0),
        notifyDeactivatedWithAssignments: wasActive && !user.active,
      };
    });

    if (outcome.kind === 'not-found') {
      return NextResponse.json({ error: 'Utilisateur non trouvé' }, { status: 404 });
    }
    if (outcome.kind === 'last-admin') {
      return NextResponse.json(
        { error: 'Impossible de désactiver ou rétrograder le dernier administrateur' },
        { status: 400 },
      );
    }

    if (outcome.revokeSessions) {
      await revokeAllSessionsForUser(outcome.userId);
    }

    // Issue #206 : désactiver un dirigeant qui a des affectations à venir mérite une
    // alerte administrateur explicite, plutôt que de découvrir le trou de couverture
    // seulement au moment de publier.
    if (outcome.notifyDeactivatedWithAssignments) {
      const { timeZone } = await readAppSettings(db, auth.user.clubId);
      if (await hasFuturePlanningAssignments(db, outcome.userId, timeZone)) {
        const user = await getRepo(db).findOneBy({ id: outcome.userId });
        await notifyAdmins(db, {
          type: 'user-deactivated-with-assignments',
          title: 'Dirigeant désactivé avec affectations à venir',
          message: `${user?.nom ?? 'Ce dirigeant'} a été désactivé alors qu'il reste affecté à au moins un événement futur.`,
        });
      }
    }

    const users = await getRepo(db).find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    return NextResponse.json({ success: true, data: { users: users.map((user) => serializeUser(user)) } });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    console.error('Error updating user in DB:', error);
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

type DeleteOutcome =
  | { kind: 'not-found' }
  | { kind: 'last-admin' }
  | { kind: 'referenced'; reasons: string[] }
  | { kind: 'deleted'; userId: number };

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const id = Number.parseInt(resolvedParams.id, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 });
    }

    const db = await getDb();
    const outcome: DeleteOutcome = await retryOnMysqlDeadlock(() => db.transaction(async (manager) => {
      const userRepo = manager.getRepository<UserEntity>('User');
      const locked = await lockTargetAndActiveAdmins(manager, auth.user.clubId, id);
      const user = locked.find((candidate) => candidate.id === id);
      if (!user) return { kind: 'not-found' };

      if (user.accessRole === 'admin') {
        const activeAdmins = locked.filter((candidate) => candidate.active && candidate.accessRole === 'admin').length;
        if (activeAdmins <= 1) return { kind: 'last-admin' };
      }

      // Préférer la désactivation à la suppression physique pour tout compte référencé
      // par des données métier existantes (issue #273) : une suppression laisserait des
      // références orphelines dans les brouillons, le planning publié, l'historique, un
      // autre enregistrement de planning ou une conversation de chat.
      const references = await findUserReferences(manager, auth.user.clubId, user.id);
      if (references.referenced) return { kind: 'referenced', reasons: references.reasons };

      // RGPD / droit à l'effacement (issue #259) : le nom d'expéditeur est dénormalisé en
      // clair sur chat_messages pour l'affichage — anonymisé avant la suppression du compte
      // pour ne pas laisser son identité attribuée à d'anciens messages. Dans la même
      // transaction que la suppression : l'un ne peut pas réussir sans l'autre.
      await anonymizeMessagesForDeletedUser(manager, user.id);
      await userRepo.remove(user);

      return { kind: 'deleted', userId: user.id };
    }));

    if (outcome.kind === 'not-found') {
      return NextResponse.json({ error: 'Utilisateur non trouvé' }, { status: 404 });
    }
    if (outcome.kind === 'last-admin') {
      return NextResponse.json({ error: 'Impossible de supprimer le dernier administrateur' }, { status: 400 });
    }
    if (outcome.kind === 'referenced') {
      return NextResponse.json(
        {
          // `details` : convention partagée par les routes qui renvoient une liste
          // structurée en plus du message générique (voir ApiRequestError.details).
          error: 'Ce compte est référencé par des données existantes et ne peut pas être supprimé définitivement : désactivez-le à la place.',
          details: outcome.reasons,
        },
        { status: 409 },
      );
    }

    await revokeAllSessionsForUser(outcome.userId);

    const users = await getRepo(db).find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    return NextResponse.json({ success: true, data: { users: users.map((user) => serializeUser(user)) } });
  } catch (error) {
    console.error('Error deleting user in DB:', error);
    return NextResponse.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
