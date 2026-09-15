import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { getPlanningRecord, savePlanningRecord } from '@/lib/planning/records';
import { normalizeNotificationPreferences } from '@/lib/notifications/preferences';
import { isWhatsAppGloballyEnabled } from '@/lib/notifications/whatsapp';
import { personTypeForFunction } from '@/lib/planning/person-link';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const db = await getDb();
  const record = await getPlanningRecord(db, `notification-preferences:${auth.user.id}`);
  return NextResponse.json({
    preferences: normalizeNotificationPreferences(record?.payload),
    whatsappAvailable: isWhatsAppGloballyEnabled(),
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  try {
    const body = await request.json();
    const preferences = normalizeNotificationPreferences(body);
    if (!isWhatsAppGloballyEnabled()) {
      preferences.whatsapp = false;
    }
    const db = await getDb();
    await savePlanningRecord(db, {
      id: `notification-preferences:${auth.user.id}`,
      kind: 'notification-preferences',
      ownerUserId: auth.user.id,
      personType: auth.user.planningFunctions[0] ? personTypeForFunction(auth.user.planningFunctions[0]) : null,
      personId: auth.user.id,
      payload: preferences,
    });
    return NextResponse.json({ success: true, preferences });
  } catch (error) {
    logError('app.unhandled', 'Notification preferences update failed:', error);
    return NextResponse.json({ error: 'Impossible de mettre à jour vos notifications' }, { status: 500 });
  }
}
