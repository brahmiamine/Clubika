import { logError } from '@/lib/observability/log';
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { revokePlatformSession, PLATFORM_SESSION_COOKIE_NAME } from '@/lib/auth/platform-session';
import { sessionCookieClearOptions } from '@/lib/auth/session-cookie';

export async function POST() {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(PLATFORM_SESSION_COOKIE_NAME)?.value;
    await revokePlatformSession(token);
    cookieStore.set(PLATFORM_SESSION_COOKIE_NAME, '', sessionCookieClearOptions());

    return NextResponse.json({ success: true });
  } catch (error) {
    logError('app.unhandled', 'Error during platform logout:', error);
    return NextResponse.json(
      { error: 'Une erreur est survenue' },
      { status: 500 },
    );
  }
}
