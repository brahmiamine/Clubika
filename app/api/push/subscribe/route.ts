import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { isTrustedPushEndpoint } from '@/lib/push/endpoint';
import { savePushSubscription, type BrowserPushSubscription } from '@/lib/push/store';
import { setCurrentClubId } from '@/lib/auth/club-context';

function isValidSubscription(value: unknown): value is BrowserPushSubscription {
  if (!value || typeof value !== 'object') return false;
  const subscription = value as BrowserPushSubscription;
  return typeof subscription.endpoint === 'string' && isTrustedPushEndpoint(subscription.endpoint);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const subscription = (await request.json()) as unknown;
    if (!isValidSubscription(subscription)) {
      return NextResponse.json({ error: 'Abonnement push invalide' }, { status: 400 });
    }

    const db = await getDb();
    await savePushSubscription(
      db,
      auth.user.id,
      subscription,
      request.headers.get('user-agent')?.slice(0, 512) ?? null,
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    logError('app.unhandled', 'Unable to save push subscription:', error);
    return NextResponse.json({ error: "Impossible d'activer les notifications push" }, { status: 500 });
  }
}
