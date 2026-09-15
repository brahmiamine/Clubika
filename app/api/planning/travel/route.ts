import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { canReadPlanningEventWorkspace } from '@/lib/planning/event-access';
import { getPlanningEventSnapshot, type PlanningEventType } from '@/lib/planning/event-store';
import { eventCoordinatesFromResources } from '@/lib/planning/resources';
import { estimateTravelMinutes, validGeoPoint, type GeoPoint } from '@/lib/planning/travel';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';

interface EventRef { eventType: PlanningEventType; eventId: string; }

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function eventRef(value: unknown): EventRef | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!validEventType(raw.eventType) || typeof raw.eventId !== 'string' || !raw.eventId.trim()) return null;
  return { eventType: raw.eventType, eventId: raw.eventId.trim() };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  try {
    const body = await request.json();
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'travelAndWeather');
    if (disabled) return disabled;

    const resolvePoint = async (raw: unknown): Promise<GeoPoint | null> => {
      if (validGeoPoint(raw)) return raw;
      const ref = eventRef(raw);
      if (!ref) return null;
      const snapshot = await getPlanningEventSnapshot(db, ref.eventType, ref.eventId);
      if (!snapshot || !canReadPlanningEventWorkspace(auth.user, snapshot)) return null;
      const point = await eventCoordinatesFromResources(db, ref.eventType, ref.eventId);
      return point ? { lat: point.lat, lon: point.lon } : null;
    };

    const [from, to] = await Promise.all([resolvePoint(body.from), resolvePoint(body.to)]);
    if (!from || !to) {
      return NextResponse.json({ status: 'unavailable', reason: 'Coordonnées manquantes ou événement inaccessible' });
    }
    return NextResponse.json(await estimateTravelMinutes(from, to));
  } catch (error) {
    logError('app.unhandled', 'Travel estimate failed:', error);
    return NextResponse.json({ status: 'unavailable', reason: 'Calcul de trajet indisponible' });
  }
}
