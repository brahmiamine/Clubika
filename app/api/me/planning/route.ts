import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { hasAnyPlanningFunction } from '@/lib/auth/roles';
import {
  buildPersonalPlanningStats,
  groupPersonalAssignmentsByEvent,
  listPersonalAssignments,
} from '@/lib/planning/personal-planning';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';
import { getPlanningWeather, toPublicEventWeather } from '@/lib/planning/weather';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  if (!hasAnyPlanningFunction(auth.user.planningFunctions)) {
    return NextResponse.json(
      { error: 'Cet espace est réservé aux arbitres, encadrants et accompagnateurs' },
      { status: 403 },
    );
  }

  try {
    const db = await getDb();
    const [assignments, settings] = await Promise.all([
      listPersonalAssignments(db, auth.user),
      readAppSettings(db, auth.user.clubId),
    ]);
    const events = groupPersonalAssignmentsByEvent(assignments);
    const eventsWithWeather = settings.features.travelAndWeather
      ? await Promise.all(
          events.map(async (event) => ({
            ...event,
            weather: toPublicEventWeather(
              await getPlanningWeather(db, event.eventType, event.eventId),
            ),
          })),
        )
      : events;
    return NextResponse.json({
      // Liste plate (une entrée par fonction), conservée pour les consommateurs qui
      // répondent/échangent affectation par affectation (ex. /mon-planning/mes-echanges).
      assignments,
      // Une carte par événement (issue #281) : un dirigeant multi-fonctions n'y apparaît
      // qu'une fois, avec ses fonctions et leurs statuts propres imbriqués.
      events: eventsWithWeather,
      // Statistiques (à venir / passé, présence en attente) calculées dans le fuseau du club (issue #45).
      stats: buildPersonalPlanningStats(assignments, settings.timeZone),
    });
  } catch (error) {
    logError('app.unhandled', 'Error loading personal planning:', error);
    return NextResponse.json({ error: 'Impossible de charger votre planning' }, { status: 500 });
  }
}
