import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getSessionUser, revokeSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { removeAllPushSubscriptionsForUser } from '@/lib/push/store';

export async function POST(request: NextRequest) {
  try {
    const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
    const user = await getSessionUser(token);
    if (user) {
      await removeAllPushSubscriptionsForUser(await getDb(), user.id);
    }
    await revokeSession(token);
    const response = NextResponse.json({ success: true });
    response.cookies.set(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    return response;
  } catch (error) {
    logError('app.unhandled', 'Error during logout:', error);
    return NextResponse.json(
      { error: 'Une erreur est survenue' },
      { status: 500 },
    );
  }
}
