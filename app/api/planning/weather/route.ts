import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { canReadPlanningEventWorkspace, personalPlanningAccessUser, resolvePlanningEventForAccess } from '@/lib/planning/event-access';
import type { PlanningEventType } from '@/lib/planning/event-store';
import { getPlanningWeather } from '@/lib/planning/weather';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';

function eventType(value: string | null): PlanningEventType | null {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau' ? value : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const params = new URL(request.url).searchParams;
  const type = eventType(params.get('eventType'));
  const eventId = params.get('eventId')?.trim();
  if (!type || !eventId) return NextResponse.json({ error: 'Événement invalide' }, { status: 400 });

  try {
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'travelAndWeather');
    if (disabled) return disabled;
    const personalScope = params.get('scope') === 'personal';
    const accessUser = personalScope ? personalPlanningAccessUser(auth.user) : auth.user;
    if (!accessUser) return NextResponse.json({ error: 'Compte personnel non lié' }, { status: 403 });
    const snapshot = await resolvePlanningEventForAccess(db, accessUser, type, eventId);
    if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });
    if (!canReadPlanningEventWorkspace(accessUser, snapshot)) {
      return NextResponse.json({ error: 'Accès interdit à la météo de cet événement' }, { status: 403 });
    }
    const weather = await getPlanningWeather(db, type, eventId);
    return NextResponse.json({ ...weather, provider: 'Open-Meteo' }, {
      headers: { 'Cache-Control': 'private, max-age=300' },
    });
  } catch (error) {
    logError('app.unhandled', 'Planning weather failed:', error);
    return NextResponse.json({ available: false, reason: 'provider-unavailable', provider: 'Open-Meteo' });
  }
}
