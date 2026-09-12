import { eventStartTimestamp } from './p0-rules';

/**
 * Couche temporelle unique du planning (issue #45) : toute interprétation métier d'une
 * date/heure d'événement doit passer par le fuseau horaire du club, jamais par un UTC
 * implicite. Ce module regroupe les calculs calendaires (jour de semaine, clé de jour,
 * semaine ISO, minuit local) évalués dans un fuseau explicite. Il est volontairement
 * pur (aucune dépendance serveur) pour être utilisable depuis n'importe quel module.
 */

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Jour de semaine (0 = dimanche … 6 = samedi) de `timestamp` dans `timeZone`. */
export function zonedWeekday(timestamp: number, timeZone: string): number {
  try {
    const label = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(timestamp));
    const index = WEEKDAY_LABELS.indexOf(label as (typeof WEEKDAY_LABELS)[number]);
    return index === -1 ? new Date(timestamp).getUTCDay() : index;
  } catch {
    return new Date(timestamp).getUTCDay();
  }
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
}

/** Année / mois (1-12) / jour calendaires de `timestamp` dans `timeZone`. */
export function zonedDateParts(timestamp: number, timeZone: string): ZonedDateParts {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const year = Number(values.year);
    const month = Number(values.month);
    const day = Number(values.day);
    if (year && month && day) return { year, month, day };
  } catch {
    // Fuseau invalide : repli UTC ci-dessous.
  }
  const fallback = new Date(timestamp);
  return { year: fallback.getUTCFullYear(), month: fallback.getUTCMonth() + 1, day: fallback.getUTCDate() };
}

/** Clé de jour `YYYY-MM-DD` dans le fuseau du club (comparaisons « même jour »). */
export function zonedDayKey(timestamp: number, timeZone: string): string {
  const { year, month, day } = zonedDateParts(timestamp, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Clé de semaine ISO `AAAA-S` calculée sur la date civile du club (les semaines commencent le lundi). */
export function zonedIsoWeekKey(timestamp: number, timeZone: string): string {
  const { year, month, day } = zonedDateParts(timestamp, timeZone);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil((((date.getTime() - yearStart) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-${week}`;
}

/** Minuit local (dans `timeZone`) du jour contenant `timestamp`, en epoch ms. */
export function zonedDayStart(timestamp: number, timeZone: string): number {
  const { year, month, day } = zonedDateParts(timestamp, timeZone);
  const date = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  return eventStartTimestamp(date, '00:00', timeZone) ?? timestamp;
}

/**
 * Fenêtre samedi 00:00 → lundi 00:00 **dans le fuseau du club** (issue #45) : un match
 * du samedi ou du dimanche doit être classé sur le bon week-end quelle que soit l'heure
 * UTC sous-jacente. Le jeudi/vendredi vise le week-end à venir ; le dimanche, celui en cours.
 */
export function weekendWindow(now = Date.now(), timeZone = 'UTC'): { start: number; end: number } {
  const weekday = zonedWeekday(now, timeZone);
  const daysUntilSaturday = weekday === 6 ? 0 : weekday === 0 ? -1 : 6 - weekday;
  const { year, month, day } = zonedDateParts(now, timeZone);
  const format = (value: Date) => `${String(value.getUTCDate()).padStart(2, '0')}/${String(value.getUTCMonth() + 1).padStart(2, '0')}/${value.getUTCFullYear()}`;
  const saturday = new Date(Date.UTC(year, month - 1, day + daysUntilSaturday));
  const monday = new Date(Date.UTC(year, month - 1, day + daysUntilSaturday + 2));
  const start = eventStartTimestamp(format(saturday), '00:00', timeZone);
  const mondayStart = eventStartTimestamp(format(monday), '00:00', timeZone);
  if (start === null || mondayStart === null) {
    const current = new Date(now);
    const utcDay = current.getUTCDay();
    const utcDaysUntilSaturday = utcDay === 6 ? 0 : utcDay === 0 ? -1 : 6 - utcDay;
    const fallbackStart = Date.UTC(
      current.getUTCFullYear(),
      current.getUTCMonth(),
      current.getUTCDate() + utcDaysUntilSaturday,
      0, 0, 0, 0,
    );
    return { start: fallbackStart, end: fallbackStart + 2 * 24 * 60 * 60_000 - 1 };
  }
  return { start, end: mondayStart - 1 };
}

/** Vrai si la date/heure (jj/mm/aaaa) tombe dans le week-end en cours du club. */
export function isWithinCurrentWeekend(date: string, time: string, timeZone: string, now = Date.now()): boolean {
  const start = eventStartTimestamp(date, time?.trim() || '00:00', timeZone);
  if (start === null) return false;
  const window = weekendWindow(now, timeZone);
  return start >= window.start && start <= window.end;
}
