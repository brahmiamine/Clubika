import { describe, expect, it } from 'vitest';
import type { PlanningEventSnapshot } from './event-store';
import { computePlanningAnalytics, fairnessCoefficient } from './analytics';

function snapshot(overrides: Partial<PlanningEventSnapshot> = {}): PlanningEventSnapshot {
  return {
    eventId: 'event-1',
    eventType: 'officiel',
    title: 'AFP – Visiteur',
    date: '16/08/2026',
    time: '15:00',
    durationMinutes: 90,
    location: 'Stade AFP',
    planningStatus: 'published',
    event: {
      id: 'event-1',
      type: 'officiel',
      date: '16/08/2026',
      time: '15:00',
      horaireRendezVous: '14:00',
      competition: 'Championnat',
      localTeam: 'AFP',
      awayTeam: 'Visiteur',
      venue: 'domicile',
    },
    extras: { id: 'event-1', planningStatus: 'published' },
    assignments: {
      arbitre: [{
        nom: 'Arbitre A',
        numero: '',
        personType: 'officiel',
        personId: 1,
        status: 'accepted',
        assignedAt: '2026-08-10T10:00:00.000Z',
        respondedAt: '2026-08-10T11:00:00.000Z',
        attendanceStatus: 'present',
      }],
      encadrant: [{
        nom: 'Encadrant B',
        numero: '',
        personType: 'encadrant',
        personId: 2,
        status: 'declined',
        assignedAt: '2026-08-10T10:00:00.000Z',
        respondedAt: '2026-08-10T12:00:00.000Z',
      }],
      accompagnateur: [],
    },
    ...overrides,
  };
}

describe('planning analytics', () => {
  it('computes acceptance, attendance, response delay, replacement and missing coverage rates', () => {
    const training = snapshot({
      eventId: 'event-2',
      eventType: 'entrainement',
      title: 'Entraînement U15',
      event: {
        id: 'event-2',
        type: 'entrainement',
        date: '17/08/2026',
        time: '18:00',
        lieu: 'Terrain 2',
        categorie: 'U15',
        encadrants: [{
          nom: 'Encadrant B',
          numero: '',
          personType: 'encadrant',
          personId: 2,
          status: 'accepted',
          assignedAt: '2026-08-10T10:00:00.000Z',
          respondedAt: '2026-08-10T10:30:00.000Z',
          attendanceStatus: 'absent',
        }],
      },
      extras: null,
      assignments: {
        arbitre: [],
        encadrant: [{
          nom: 'Encadrant B',
          numero: '',
          personType: 'encadrant',
          personId: 2,
          status: 'accepted',
          assignedAt: '2026-08-10T10:00:00.000Z',
          respondedAt: '2026-08-10T10:30:00.000Z',
          attendanceStatus: 'absent',
        }],
        accompagnateur: [],
      },
    });

    // `now` fixé juste après les événements de la fixture : la fenêtre d'analyse par
    // défaut (issue #16) ne doit pas dépendre de la date d'exécution du test.
    const now = new Date('2026-08-20T00:00:00.000Z');
    const result = computePlanningAnalytics([snapshot(), training], undefined, { now });

    expect(result.acceptanceRate).toBeCloseTo(66.67, 1);
    expect(result.attendanceRate).toBe(50);
    expect(result.averageResponseDelayMinutes).toBe(70);
    // 4 required role slots: 3 on the match + 1 on training. Only the match's encadrant
    // role had a contact assigned (declined) and ended up with zero active coverage: 1 / 4 = 25%.
    // The empty accompagnateur role was never assigned — that's missingCoverageRate, not a
    // replacement need (issue #220).
    expect(result.replacementRate).toBe(25);
    // Raw decline rate stays available under its own, unambiguous label.
    expect(result.declineRate).toBeCloseTo(33.33, 1);
    // The declined encadrant and the never-assigned accompagnateur leave two match roles
    // uncovered, so 2 / 4 = 50%.
    expect(result.missingCoverageRate).toBe(50);
    expect(result.workload).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: 'encadrant:2', assignments: 2 }),
      expect.objectContaining({ identity: 'officiel:1', assignments: 1 }),
    ]));
  });

  it('does not count a role as needing replacement once someone else has accepted it (issue #220)', () => {
    const covered = snapshot({
      assignments: {
        arbitre: [{
          nom: 'Arbitre A', numero: '', personType: 'officiel', personId: 1, status: 'accepted',
        }],
        // Deux personnes sollicitées pour le même rôle : la première refuse, la seconde
        // accepte. Le rôle finit couvert : ce n'est plus un besoin de remplacement, même si
        // un refus a bien eu lieu (visible dans declineRate).
        encadrant: [
          { nom: 'Encadrant B', numero: '', personType: 'encadrant', personId: 2, status: 'declined' },
          { nom: 'Encadrant C', numero: '', personType: 'encadrant', personId: 3, status: 'accepted' },
        ],
        accompagnateur: [{
          nom: 'Accompagnateur D', numero: '', personType: 'accompagnateur', personId: 4, status: 'accepted',
        }],
      },
    });

    const result = computePlanningAnalytics([covered], undefined, { now: new Date('2026-08-20T00:00:00.000Z') });

    expect(result.replacementRate).toBe(0);
    expect(result.missingCoverageRate).toBe(0);
    // Le refus individuel reste visible dans le taux de refus brut.
    expect(result.declineRate).toBeCloseTo(25, 1);
  });

  it('returns a normalized fairness coefficient where equal workloads are fairest', () => {
    expect(fairnessCoefficient([2, 2])).toBe(1);
    expect(fairnessCoefficient([4, 0])).toBe(0.5);
    expect(fairnessCoefficient([])).toBe(1);
  });

  it('exposes only the assignment count nominatively — no individual decline/presence/absence (issue #16)', () => {
    const now = new Date('2026-08-20T00:00:00.000Z');
    const result = computePlanningAnalytics([snapshot()], undefined, { now });

    expect(result.workload.length).toBeGreaterThan(0);
    // Forme minimale : uniquement identity/nom/assignments, jamais accepted/declined/present/absent.
    for (const item of result.workload) {
      expect(Object.keys(item).sort()).toEqual(['assignments', 'identity', 'nom']);
      expect(item).not.toHaveProperty('declined');
      expect(item).not.toHaveProperty('present');
      expect(item).not.toHaveProperty('absent');
      expect(item).not.toHaveProperty('accepted');
    }
    // Les agrégats globaux (jamais nominatifs) restent disponibles pour couverture/équité.
    expect(result).toHaveProperty('acceptanceRate');
    expect(result).toHaveProperty('attendanceRate');
    expect(result).toHaveProperty('declineRate');
  });

  it('bounds the analyzed period and excludes events older than it (issue #16)', () => {
    const now = new Date('2026-08-20T00:00:00.000Z');
    const recent = snapshot();
    const old = snapshot({
      eventId: 'event-old',
      date: '01/01/2020',
      assignments: {
        arbitre: [{
          nom: 'Vieil arbitre', numero: '', personType: 'officiel', personId: 999, status: 'accepted',
        }],
        encadrant: [],
        accompagnateur: [],
      },
    });

    const result = computePlanningAnalytics([recent, old], undefined, { now, periodDays: 90 });

    expect(result.events).toBe(1);
    expect(result.workload.some((item) => item.identity === 'officiel:999')).toBe(false);
    expect(result.analyzedPeriod).toEqual({
      days: 90,
      from: new Date('2026-05-22T00:00:00.000Z').toISOString(),
      to: now.toISOString(),
    });
  });

  it('applies the default analysis period when none is given', () => {
    const now = new Date('2026-08-20T00:00:00.000Z');
    const result = computePlanningAnalytics([snapshot()], undefined, { now });
    expect(result.analyzedPeriod.days).toBe(180);
  });
});
