import { describe, expect, it } from 'vitest';
import type { PlanningEventSnapshot } from './event-store';
import {
  assignmentWithinAvailabilityResponse,
  isDeclineReason,
  normalizeAvailabilityResponse,
  normalizePlanningPreferences,
  scorePreferenceMatch,
} from './advanced-rules';

const target: PlanningEventSnapshot = {
  eventId: 'event-1',
  eventType: 'officiel',
  title: 'AFP – Club',
  date: '23/08/2026',
  time: '15:00',
  durationMinutes: 90,
  location: 'Stade Poissonniers',
  planningStatus: 'published',
  event: {
    id: 'event-1',
    type: 'officiel',
    date: '23/08/2026',
    time: '15:00',
    horaireRendezVous: '14:00',
    competition: 'Championnat',
    categorie: 'U15',
    localTeam: 'AFP',
    awayTeam: 'Club',
    venue: 'domicile',
  },
  extras: { id: 'event-1', planningStatus: 'published' },
  assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
};

describe('advanced planning rules', () => {
  it('rejects injury as a structured decline reason (issue #7)', () => {
    expect(isDeclineReason('injury')).toBe(false);
    expect(isDeclineReason('personal')).toBe(true);
  });

  it('normalizes preferences and scores matching category, time and location', () => {
    const preferences = normalizePlanningPreferences({
      preferredCategories: [' U15 ', 'U15'],
      preferredWeekdays: [0, 8, 0],
      preferredTimeRanges: [{ start: '14:00', end: '18:00' }],
      preferredLocations: ['Poissonniers'],
      maxAssignmentsPerWeek: 3,
      maxTravelMinutes: 45,
    });

    expect(preferences.preferredCategories).toEqual(['U15']);
    const result = scorePreferenceMatch(preferences, target);
    expect(result.bonus).toBeGreaterThanOrEqual(29);
    expect(result.reasons).toContain('Catégorie préférée : U15');
  });

  it('requires a valid window for partial availability', () => {
    expect(normalizeAvailabilityResponse({ status: 'partial', availableFrom: '16:00', availableUntil: '14:00' })).toBeNull();
    const response = normalizeAvailabilityResponse({ status: 'partial', availableFrom: '14:00', availableUntil: '17:00' });
    expect(response).not.toBeNull();
    expect(response && assignmentWithinAvailabilityResponse(response, '15:00')).toBe(true);
    expect(response && assignmentWithinAvailabilityResponse(response, '18:00')).toBe(false);
    expect(response && assignmentWithinAvailabilityResponse(response, '16:30', 90)).toBe(false);
    expect(response && assignmentWithinAvailabilityResponse(response, '15:00', 90)).toBe(true);
  });
});
