import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
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
      if (body.newPassword.length < 8) {
        return NextResponse.json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' }, { status: 400 });
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
    logError('app.unhandled', 'Error updating profile:', error);
    return NextResponse.json({ error: 'Impossible de mettre à jour votre profil' }, { status: 500 });
  }
}
