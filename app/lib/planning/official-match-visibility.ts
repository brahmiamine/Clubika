import type { AppSettings } from '@/lib/settings';
import { isWithinCurrentWeekend } from './planning-time';

type WeekendDisplaySettings = Pick<AppSettings, 'timeZone'> & {
  features: Pick<AppSettings['features'], 'officialMatchesCurrentWeekendOnly'>;
};

function weekendOnlyEnabled(settings: WeekendDisplaySettings): boolean {
  return settings.features.officialMatchesCurrentWeekendOnly;
}

/** Filtre les matchs officiels scrapés au week-end en cours quand le paramètre club est actif. */
export function filterOfficialMatchesForDisplay<T extends { date: string; time?: string }>(
  matches: T[],
  settings: WeekendDisplaySettings,
  now = Date.now(),
): T[] {
  if (!weekendOnlyEnabled(settings)) return matches;
  return matches.filter((match) => isWithinCurrentWeekend(match.date, match.time ?? '00:00', settings.timeZone, now));
}

/**
 * Masque les événements `officiel` hors week-end, laisse les autres types inchangés.
 * Ne s’applique pas aux Archives, qui listent les matchs passés / disparus / annulés.
 */
export function filterOfficialEventsForDisplay<T extends { date: string; time?: string; eventType?: string; type?: string }>(
  events: T[],
  settings: WeekendDisplaySettings,
  now = Date.now(),
): T[] {
  if (!weekendOnlyEnabled(settings)) return events;
  return events.filter((event) => {
    const kind = event.eventType ?? event.type;
    if (kind !== 'officiel') return true;
    return isWithinCurrentWeekend(event.date, event.time ?? '00:00', settings.timeZone, now);
  });
}
