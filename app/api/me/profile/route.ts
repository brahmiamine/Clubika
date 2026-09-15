import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { assertPasswordPolicy } from '@/lib/auth/password-policy';
import { isNotifyChannel, revokeAllSessionsForUser } from '@/lib/auth/session';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const user = await repo.findOneBy({ id: auth.user.id });
    if (!user) return NextResponse.json({ error: 'Utilisateur introuvable' }, { status: 404 });

    if (typeof body.nom === 'string' && body.nom.trim()) {
      user.nom = body.nom.trim();
    }

    if (isNotifyChannel(body.notifyChannel)) {
      user.notifyChannel = body.notifyChannel;
    }

    let passwordChanged = false;
    if (typeof body.newPassword === 'string' && body.newPassword.length > 0) {
      const policyError = await assertPasswordPolicy(body.newPassword);
      if (policyError) {
        return NextResponse.json({ error: policyError }, { status: 400 });
      }
      if (typeof body.currentPassword !== 'string' || !(await verifyPassword(body.currentPassword, user.passwordHash))) {
        return NextResponse.json({ error: 'Mot de passe actuel incorrect' }, { status: 400 });
      }
      user.passwordHash = await hashPassword(body.newPassword);
      passwordChanged = true;
    }

    await repo.save(user);
    if (passwordChanged) await revokeAllSessionsForUser(user.id);

    return NextResponse.json({ success: true, passwordChanged });
  } catch (error) {
    console.error('Error updating profile:', error);
    return NextResponse.json({ error: 'Impossible de mettre à jour votre profil' }, { status: 500 });
  }
}
