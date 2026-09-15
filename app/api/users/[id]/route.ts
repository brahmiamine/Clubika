import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { hashPassword } from '@/lib/auth/password';
import { normalizeAccessRole, normalizePlanningFunctions } from '@/lib/auth/roles';
import { revokeAllSessionsForUser } from '@/lib/auth/session';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { hasFuturePlanningAssignments } from '@/lib/planning/person-link';
import { notifyAdmins } from '@/lib/notifications/service';
import { readAppSettings } from '@/lib/settings-store';
import {
  AccountClosureError,
  closeAccount,
  countLockedActiveAdmins,
  lockTargetAndActiveAdmins,
} from '@/lib/account-closure/close-account';
import { isClosedAccount } from '@/lib/account-closure/constants';

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
  const closed = isClosedAccount(user);
  return {
    id: user.id,
    email: closed ? '' : user.email,
    nom: user.nom,
    accessRole: user.accessRole,
    planningFunctions: user.planningFunctions,
    active: user.active,
    telephone: closed ? null : user.telephone,
    closedAt: user.closedAt,
    closureRequestedAt: user.closureRequestedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function getRepo(db: Awaited<ReturnType<typeof getDb>>) {
  return db.getRepository<UserEntity>('User');
}

type PutOutcome =
  | { kind: 'not-found' }
  | { kind: 'last-admin' }
  | { kind: 'closed' }
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
      if (isClosedAccount(user)) return { kind: 'closed' };

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
        if (countLockedActiveAdmins(locked) <= 1) return { kind: 'last-admin' };
      }

      if (typeof nom === 'string' && nom.trim() !== '') user.nom = nom.trim();
      user.accessRole = nextAccessRole;
      user.planningFunctions = nextFunctions;
      user.active = nextActive;
      if (typeof telephone === 'string') user.telephone = telephone.trim() || null;
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
    if (outcome.kind === 'closed') {
      return NextResponse.json({ error: 'Ce compte est déjà fermé et ne peut plus être modifié' }, { status: 409 });
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
    return NextResponse.json({ success: true, data: { users: users.map(serializeUser) } });
  } catch (error) {
    console.error('Error updating user in DB:', error);
    return NextResponse.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

type DeleteOutcome =
  | { kind: 'not-found' }
  | { kind: 'last-admin' }
  | { kind: 'closed'; result: Awaited<ReturnType<typeof closeAccount>> }
  | { kind: 'ok'; result: Awaited<ReturnType<typeof closeAccount>> };

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
    const dryRun = new URL(request.url).searchParams.get('dryRun') === 'true';

    const db = await getDb();
    const outcome: DeleteOutcome = await retryOnMysqlDeadlock(() => db.transaction(async (manager) => {
      const locked = await lockTargetAndActiveAdmins(manager, auth.user.clubId, id);
      const user = locked.find((candidate) => candidate.id === id);
      if (!user) return { kind: 'not-found' as const };

      try {
        const result = await closeAccount(manager, {
          target: user,
          processedByUserId: auth.user.id,
          processedByRole: 'admin',
          dryRun,
          activeAdminCount: countLockedActiveAdmins(locked),
        });
        return { kind: result.alreadyClosed ? 'closed' as const : 'ok' as const, result };
      } catch (error) {
        if (error instanceof AccountClosureError && error.code === 'last-admin') {
          return { kind: 'last-admin' as const };
        }
        throw error;
      }
    }));

    if (outcome.kind === 'not-found') {
      return NextResponse.json({ error: 'Utilisateur non trouvé' }, { status: 404 });
    }
    if (outcome.kind === 'last-admin') {
      return NextResponse.json(
        { error: 'Impossible de fermer le dernier administrateur : transférez d’abord le rôle à un autre compte.' },
        { status: 400 },
      );
    }

    if (!dryRun) {
      await revokeAllSessionsForUser(outcome.result.userId);
    }

    const users = await getRepo(db).find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    return NextResponse.json({
      success: true,
      closure: outcome.result,
      data: { users: users.map(serializeUser) },
    });
  } catch (error) {
    console.error('Error closing user account:', error);
    return NextResponse.json({ error: 'Failed to close user account' }, { status: 500 });
  }
}
