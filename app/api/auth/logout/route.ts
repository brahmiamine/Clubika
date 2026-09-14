import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { getSessionUser, revokeSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { sessionCookieClearOptions } from '@/lib/auth/session-cookie';
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
    response.cookies.set(SESSION_COOKIE_NAME, '', sessionCookieClearOptions());
    return response;
  } catch (error) {
    console.error('Error during logout:', error);
    return NextResponse.json(
      { error: 'Une erreur est survenue' },
      { status: 500 },
    );
  }
}
