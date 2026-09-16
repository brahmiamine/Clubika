import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { requireAuth } from '@/lib/auth/require';
import { verifyPassword } from '@/lib/auth/password';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { touchClubSessionAuth } from '@/lib/auth/recent-auth';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { logError } from '@/lib/observability/log';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json() as { password?: unknown };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) {
      return NextResponse.json({ error: 'Mot de passe requis' }, { status: 400 });
    }

    const db = await getDb();
    const user = await db.getRepository<UserEntity>('User').findOneBy({ id: auth.user.id });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return NextResponse.json({ error: 'Mot de passe incorrect' }, { status: 401 });
    }

    await touchClubSessionAuth(request.cookies.get(SESSION_COOKIE_NAME)?.value);
    return NextResponse.json({ success: true });
  } catch (error) {
    logError('app.unhandled', 'Reauthentication failed:', error);
    return NextResponse.json({ error: 'Impossible de réauthentifier la session' }, { status: 500 });
  }
}
