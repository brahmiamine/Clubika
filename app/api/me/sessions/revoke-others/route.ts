import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { revokeOtherSessionsForUser } from '@/lib/auth/session';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
  }
  const revoked = await revokeOtherSessionsForUser(auth.user.id, token);
  return NextResponse.json({ success: true, revoked });
}
