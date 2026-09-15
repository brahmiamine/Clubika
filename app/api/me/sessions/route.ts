import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { listPublicSessionsForUser } from '@/lib/auth/session';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const sessions = await listPublicSessionsForUser(auth.user.id, token);
  return NextResponse.json({ sessions });
}
