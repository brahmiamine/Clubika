import { logError } from '@/lib/observability/log';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { IsNull, type EntityManager } from 'typeorm';
import { getDb } from '@/lib/db';
import type { PasswordResetTokenEntity, UserEntity } from '@/lib/db/schemas';
import { hashPassword } from '@/lib/auth/password';
import { assertPasswordPolicy } from '@/lib/auth/password-policy';
import { revokeAllSessionsForUser } from '@/lib/auth/session';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Porte le statut HTTP à renvoyer, levée depuis la transaction (issue #271). */
class PasswordResetConfirmError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function confirmPasswordResetInTransaction(
  manager: EntityManager,
  tokenHash: string,
  newPassword: string,
): Promise<{ userId: number }> {
  const resetRepo = manager.getRepository<PasswordResetTokenEntity>('PasswordResetToken');
  const userRepo = manager.getRepository<UserEntity>('User');

  // Verrou pessimiste sur la ligne du jeton : deux confirmations concurrentes pour le
  // même jeton se sérialisent ici, la seconde ne voit le `usedAt` posé par la première
  // qu'une fois sa transaction validée (issue #271).
  const reset = await resetRepo
    .createQueryBuilder('reset')
    .setLock('pessimistic_write')
    .where('reset.tokenHash = :tokenHash', { tokenHash })
    .getOne();

  if (!reset || reset.usedAt || new Date(reset.expiresAt).getTime() <= Date.now()) {
    throw new PasswordResetConfirmError(410, 'Ce lien est invalide ou expiré');
  }

  const user = await userRepo.findOneBy({ id: reset.userId });
  if (!user || !user.active || !hasAccountAccess(user)) {
    throw new PasswordResetConfirmError(410, 'Ce lien est invalide ou expiré');
  }

  user.passwordHash = await hashPassword(newPassword);
  await userRepo.save(user);

  // Consommation atomique et conditionnelle, en plus du verrou pessimiste ci-dessus
  // (défense en profondeur) : si la ligne a été marquée utilisée entre-temps par un
  // autre chemin, l'update n'affecte aucune ligne et la transaction est annulée —
  // le mot de passe modifié ci-dessus est alors annulé lui aussi.
  const consumed = await resetRepo.update(
    { tokenHash, usedAt: IsNull() },
    { usedAt: new Date() },
  );
  if (consumed.affected !== 1) {
    throw new PasswordResetConfirmError(410, 'Ce lien est invalide ou expiré');
  }

  return { userId: user.id };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return NextResponse.json({ error: 'Ce lien est invalide ou expiré' }, { status: 400 });
    }
    const policyError = await assertPasswordPolicy(newPassword);
    if (policyError) {
      return NextResponse.json({ error: policyError }, { status: 400 });
    }

    const db = await getDb();
    const { userId } = await db.transaction((manager) => confirmPasswordResetInTransaction(manager, hashToken(token), newPassword));
    await revokeAllSessionsForUser(userId);

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof PasswordResetConfirmError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logError('app.unhandled', 'Password reset confirmation failed:', error);
    return NextResponse.json({ error: 'Impossible de réinitialiser le mot de passe' }, { status: 500 });
  }
}
