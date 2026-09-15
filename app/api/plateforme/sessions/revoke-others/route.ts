import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { PLATFORM_SESSION_COOKIE_NAME, revokeOtherPlatformSessions } from '@/lib/auth/platform-session';

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  const token = request.cookies.get(PLATFORM_SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ error: 'Non authentifié' }, { status: 401 });
  }
  const revoked = await revokeOtherPlatformSessions(auth.admin.id, token);
  return NextResponse.json({ success: true, revoked });
}
