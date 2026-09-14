import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { PLATFORM_SESSION_COOKIE_NAME, listPublicPlatformSessions } from '@/lib/auth/platform-session';

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  const token = request.cookies.get(PLATFORM_SESSION_COOKIE_NAME)?.value;
  const sessions = await listPublicPlatformSessions(auth.admin.id, token);
  return NextResponse.json({ sessions });
}
