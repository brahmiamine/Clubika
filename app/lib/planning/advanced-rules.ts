import type { PlanningEventSnapshot } from './event-store';
import { eventStartTimestamp } from './p0-rules';
import { zonedWeekday } from './planning-time';

export type DeclineReason = 'work' | 'travel' | 'other_assignment' | 'personal' | 'other';
export type AvailabilityResponseStatus = 'available' | 'unavailable' | 'partial';

export interface TimeRangePreference {
  start: string;
  end: string;
}

export interface PersonPlanningPreferences {
  preferredCategories: string[];
  preferredWeekdays: number[];
  preferredTimeRanges: TimeRangePreference[];
  preferredLocations: string[];
  maxAssignmentsPerWeek: number | null;
  maxTravelMinutes: number | null;
}

export const DEFAULT_PLANNING_PREFERENCES: PersonPlanningPreferences = {
  preferredCategories: [],
  preferredWeekdays: [],
  preferredTimeRanges: [],
  preferredLocations: [],
  maxAssignmentsPerWeek: null,
  maxTravelMinutes: null,
};

export const DECLINE_REASONS: DeclineReason[] = [
  'work',
  'travel',
  'other_assignment',
  'personal',
  'other',
];

export function isDeclineReason(value: unknown): value is DeclineReason {
  return typeof value === 'string' && (DECLINE_REASONS as string[]).includes(value);
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}

function normalizeNullableInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizePlanningPreferences(value: unknown): PersonPlanningPreferences {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const weekdays = Array.isArray(raw.preferredWeekdays)
    ? [...new Set(raw.preferredWeekdays.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
    : [];
  const timeRanges = Array.isArray(raw.preferredTimeRanges)
    ? raw.preferredTimeRanges.flatMap((range) => {
      if (!range || typeof range !== 'object') return [];
      const item = range as Record<string, unknown>;
      if (!validTime(item.start) || !validTime(item.end) || item.start >= item.end) return [];
      return [{ start: item.start, end: item.end }];
    }).slice(0, 10)
    : [];

  return {
    preferredCategories: normalizeList(raw.preferredCategories),
    preferredWeekdays: weekdays,
    preferredTimeRanges: timeRanges,
    preferredLocations: normalizeList(raw.preferredLocations),
    maxAssignmentsPerWeek: normalizeNullableInt(raw.maxAssignmentsPerWeek, 1, 20),
    maxTravelMinutes: normalizeNullableInt(raw.maxTravelMinutes, 5, 360),
  };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('fr');
}

function eventCategory(target: PlanningEventSnapshot): string | null {
  if ('categorie' in target.event && typeof target.event.categorie === 'string') return target.event.categorie;
  if ('categories' in target.event && Array.isArray(target.event.categories)) return target.event.categories[0] ?? null;
  return null;
}

function minutesOfDay(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)/.exec(time.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function scorePreferenceMatch(
  preferences: PersonPlanningPreferences,
  target: PlanningEventSnapshot,
  timeZone = 'UTC',
): { bonus: number; reasons: string[] } {
  let bonus = 0;
  const reasons: string[] = [];
  const category = eventCategory(target);
  if (category && preferences.preferredCategories.some((item) => normalizeText(item) === normalizeText(category))) {
    bonus += 15;
    reasons.push(`Catégorie préférée : ${category}`);
  }

  const start = eventStartTimestamp(target.date, target.time, timeZone);
  if (start !== null) {
    // Jour de semaine dans le fuseau du club (issue #45) : un match à 00:30 heure de Paris
    // appartient au jour civil parisien, pas au jour UTC.
    const weekday = zonedWeekday(start, timeZone);
    if (preferences.preferredWeekdays.includes(weekday)) {
      bonus += 8;
      reasons.push('Jour préféré');
    }
  }

  const targetMinutes = minutesOfDay(target.time);
  if (targetMinutes !== null && preferences.preferredTimeRanges.some((range) => {
    const from = minutesOfDay(range.start);
    const to = minutesOfDay(range.end);
    return from !== null && to !== null && targetMinutes >= from && targetMinutes <= to;
  })) {
    bonus += 8;
    reasons.push('Créneau préféré');
  }

  if (target.location && preferences.preferredLocations.some((item) => normalizeText(target.location).includes(normalizeText(item)))) {
    bonus += 6;
    reasons.push('Lieu préféré');
  }

  return { bonus, reasons };
}

export interface AvailabilityResponseInput {
  status: AvailabilityResponseStatus;
  availableFrom?: string | null;
  availableUntil?: string | null;
  comment?: string | null;
}

export function normalizeAvailabilityResponse(value: unknown): AvailabilityResponseInput | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.status !== 'available' && raw.status !== 'unavailable' && raw.status !== 'partial') return null;
  const comment = typeof raw.comment === 'string' ? raw.comment.trim().slice(0, 500) : null;
  if (raw.status !== 'partial') return { status: raw.status, availableFrom: null, availableUntil: null, comment };
  if (!validTime(raw.availableFrom) || !validTime(raw.availableUntil) || raw.availableFrom >= raw.availableUntil) return null;
  return {
    status: 'partial',
    availableFrom: raw.availableFrom,
    availableUntil: raw.availableUntil,
    comment,
  };
}

export function assignmentWithinAvailabilityResponse(
  response: AvailabilityResponseInput,
  eventTime: string,
  durationMinutes = 0,
): boolean {
  if (response.status === 'available') return true;
  if (response.status === 'unavailable') return false;
  const eventMinutes = minutesOfDay(eventTime);
  const from = minutesOfDay(response.availableFrom ?? '');
  const to = minutesOfDay(response.availableUntil ?? '');
  if (eventMinutes === null || from === null || to === null) return false;
  const eventEnd = eventMinutes + Math.max(0, durationMinutes);
  return eventMinutes >= from && eventEnd <= to;
}
