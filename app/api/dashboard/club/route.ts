import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { buildClubDashboardData } from '@/lib/planning/dashboard-data';
import { buildPlanningAnalytics } from '@/lib/planning/analytics';
import { getWeekendPlanning } from '@/lib/planning/weekend';
import { getPlanningWeather } from '@/lib/planning/weather';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const [base, analytics, weekend] = await Promise.all([
      buildClubDashboardData(db, auth.user.id),
      buildPlanningAnalytics(db),
      getWeekendPlanning(db),
    ]);

    const weatherResults = await Promise.all(
      weekend.items.slice(0, 8).map(async (item) => ({
        eventId: item.eventId,
        eventType: item.eventType,
        title: item.title,
        date: item.date,
        time: item.time,
        weather: await getPlanningWeather(db, item.eventType, item.eventId),
      })),
    );
    const weatherAlerts = weatherResults.filter(
      (item) => item.weather.available && item.weather.severity !== 'normal',
    );

    return NextResponse.json({ ...base, analytics, weekend, weatherAlerts });
  } catch (error) {
    logError('app.unhandled', 'Club dashboard failed:', error);
    return NextResponse.json({ error: 'Impossible de charger le dashboard' }, { status: 500 });
  }
}
