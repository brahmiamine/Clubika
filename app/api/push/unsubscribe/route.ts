import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { removePushSubscription } from '@/lib/push/store';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = (await request.json()) as { endpoint?: unknown };
    if (typeof body.endpoint !== 'string' || body.endpoint.length > 4096) {
      return NextResponse.json({ error: 'Endpoint push invalide' }, { status: 400 });
    }

    const db = await getDb();
    await removePushSubscription(db, auth.user.id, body.endpoint);
    return NextResponse.json({ success: true });
  } catch (error) {
    logError('app.unhandled', 'Unable to remove push subscription:', error);
    return NextResponse.json({ error: 'Impossible de désactiver les notifications push' }, { status: 500 });
  }
}
