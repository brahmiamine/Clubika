import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { requireAuth } from '@/lib/auth/require';
import { revokeAllSessionsForUser } from '@/lib/auth/session';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { notifyAdmins } from '@/lib/notifications/service';
import {
  AccountClosureError,
  closeAccount,
  countLockedActiveAdmins,
  lockTargetAndActiveAdmins,
  markClosureRequested,
  previewAccountClosure,
} from '@/lib/account-closure/close-account';
import { isClosedAccount } from '@/lib/account-closure/constants';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const db = await getDb();
  const user = await db.getRepository<UserEntity>('User').findOneBy({ id: auth.user.id });
  const preview = await previewAccountClosure(db, auth.user.clubId, auth.user.id);
  return NextResponse.json({
    requested: Boolean(user?.closureRequestedAt),
    requestedAt: user?.closureRequestedAt ?? null,
    alreadyClosed: Boolean(user && isClosedAccount(user)),
    preview,
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  let confirm = false;
  try {
    const body = await request.json() as { confirm?: unknown };
    confirm = body?.confirm === true;
  } catch {
    confirm = false;
  }

  try {
    const db = await getDb();
    const outcome = await db.transaction(async (manager) => {
      const locked = await lockTargetAndActiveAdmins(manager, auth.user.clubId, auth.user.id);
      const user = locked.find((candidate) => candidate.id === auth.user.id);
      if (!user) {
        throw new AccountClosureError('not-found', 'Utilisateur introuvable');
      }
      if (isClosedAccount(user)) {
        return { kind: 'already-closed' as const, user };
      }

      const activeAdmins = countLockedActiveAdmins(locked);
      if (user.accessRole === 'admin' && user.active && activeAdmins <= 1) {
        throw new AccountClosureError(
          'last-admin',
          'Impossible de fermer le dernier administrateur : transférez d’abord le rôle à un autre compte.',
        );
      }

      if (!confirm) {
        const requestedAt = await markClosureRequested(manager, user);
        const preview = await previewAccountClosure(manager, user.clubId, user.id);
        return { kind: 'requested' as const, requestedAt, preview };
      }

      const result = await closeAccount(manager, {
        target: user,
        processedByUserId: auth.user.id,
        processedByRole: 'self',
        activeAdminCount: activeAdmins,
      });
      return { kind: 'closed' as const, result };
    });

    if (outcome.kind === 'already-closed') {
      return NextResponse.json({
        success: true,
        alreadyClosed: true,
        preview: await previewAccountClosure(db, auth.user.clubId, auth.user.id),
      });
    }

    if (outcome.kind === 'requested') {
      await notifyAdmins(db, {
        type: 'account-closure-requested',
        title: 'Demande de fermeture de compte',
        message: `${auth.user.nom} a demandé la fermeture et l’anonymisation de son compte.`,
      });
      return NextResponse.json({
        success: true,
        requested: true,
        requestedAt: outcome.requestedAt,
        preview: outcome.preview,
      });
    }

    await revokeAllSessionsForUser(outcome.result.userId);
    await notifyAdmins(db, {
      type: 'account-closure-processed',
      title: 'Compte fermé et anonymisé',
      message: 'Un compte a été fermé. L’identité nominative a été remplacée par « Utilisateur supprimé ».',
    });
    return NextResponse.json({ success: true, closure: outcome.result });
  } catch (error) {
    if (error instanceof AccountClosureError && error.code === 'last-admin') {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof AccountClosureError && error.code === 'not-found') {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    console.error('Error processing account closure request:', error);
    return NextResponse.json({ error: 'Impossible de traiter la fermeture du compte' }, { status: 500 });
  }
}
