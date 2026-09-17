import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { getCurrentClubId, runWithClubId } from '@/lib/auth/club-context';
import type { PlanningEventSnapshot } from './event-store';

/**
 * Isolation inter-clubs de `buildPlanningAnalytics` (issue #16). Les fonctions de lecture
 * (event-store, published-planning, settings-store) sont simulées mais restent scopées par
 * la portée club réelle (`getCurrentClubId`, `runWithClubId`) : ce test vérifie que la
 * fonction sous test ne mélange jamais les données de deux clubs différents, exactement
 * comme le ferait une fuite de portée en production.
 */
const mocks = vi.hoisted(() => ({
  listPlanningEventSnapshots: vi.fn(),
  listPublishedPlanningEventSnapshots: vi.fn(),
  hydratePlanningAssignmentStates: vi.fn(),
  readAppSettings: vi.fn(),
}));

vi.mock('./event-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./event-store')>();
  return { ...actual, listPlanningEventSnapshots: mocks.listPlanningEventSnapshots };
});
vi.mock('./published-planning', () => ({
  listPublishedPlanningEventSnapshots: mocks.listPublishedPlanningEventSnapshots,
}));
vi.mock('./assignment-state-overlay', () => ({
  hydratePlanningAssignmentStates: mocks.hydratePlanningAssignmentStates,
}));
vi.mock('@/lib/settings-store', () => ({ readAppSettings: mocks.readAppSettings }));

import { buildPlanningAnalytics } from './analytics';

function ddmmyyyy(date: Date): string {
  return `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
}

// Un événement récent (hier) : toujours dans la fenêtre d'analyse par défaut, quelle que
// soit la date d'exécution du test.
const recentDate = ddmmyyyy(new Date(Date.now() - 24 * 60 * 60 * 1000));

function snapshotFor(clubMarker: string, personName: string, personId: number): PlanningEventSnapshot {
  return {
    eventId: `event-${clubMarker}`,
    eventType: 'officiel',
    title: `Match ${clubMarker}`,
    date: recentDate,
    time: '15:00',
    durationMinutes: 90,
    location: 'Stade',
    planningStatus: 'published',
    event: {
      id: `event-${clubMarker}`,
      type: 'officiel',
      date: recentDate,
      time: '15:00',
      horaireRendezVous: '14:00',
      competition: 'Championnat',
      localTeam: 'Local',
      awayTeam: 'Visiteur',
      venue: 'domicile',
    },
    extras: null,
    assignments: {
      arbitre: [{
        nom: personName,
        numero: '',
        personType: 'officiel',
        personId,
        status: 'accepted',
      }],
      encadrant: [],
      accompagnateur: [],
    },
  };
}

describe('buildPlanningAnalytics — isolation inter-clubs (issue #16)', () => {
  const fakeDb = {} as DataSource;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAppSettings.mockImplementation(async (_db: unknown, clubId: string) => ({
      features: {
        requireArbitreForPublication: true,
        requireEncadrantForPublication: false,
        requireAccompagnateurForPublication: false,
      },
      timeZone: 'UTC',
      __clubId: clubId,
    }));
    mocks.listPublishedPlanningEventSnapshots.mockResolvedValue(null);
    mocks.listPlanningEventSnapshots.mockImplementation(async () => {
      const clubId = getCurrentClubId();
      return clubId === 'club-a'
        ? [snapshotFor('club-a', 'Arbitre Club A', 1)]
        : [snapshotFor('club-b', 'Arbitre Club B', 2)];
    });
  });

  it('ne renvoie jamais les personnes ou évènements d’un autre club', async () => {
    const resultA = await runWithClubId('club-a', () => buildPlanningAnalytics(fakeDb));
    const resultB = await runWithClubId('club-b', () => buildPlanningAnalytics(fakeDb));

    expect(resultA.workload.map((item) => item.nom)).toEqual(['Arbitre Club A']);
    expect(resultB.workload.map((item) => item.nom)).toEqual(['Arbitre Club B']);
    expect(resultA.workload.some((item) => item.nom === 'Arbitre Club B')).toBe(false);
    expect(resultB.workload.some((item) => item.nom === 'Arbitre Club A')).toBe(false);
  });

  it('interroge les paramètres et le planning publié avec le clubId de la portée en cours, jamais un autre', async () => {
    await runWithClubId('club-a', () => buildPlanningAnalytics(fakeDb));
    await runWithClubId('club-b', () => buildPlanningAnalytics(fakeDb));

    expect(mocks.readAppSettings).toHaveBeenNthCalledWith(1, fakeDb, 'club-a');
    expect(mocks.readAppSettings).toHaveBeenNthCalledWith(2, fakeDb, 'club-b');
    expect(mocks.listPublishedPlanningEventSnapshots).toHaveBeenNthCalledWith(1, fakeDb, 'club-a');
    expect(mocks.listPublishedPlanningEventSnapshots).toHaveBeenNthCalledWith(2, fakeDb, 'club-b');
  });

  it('borne l’analyse à une période définie même en isolation multi-club', async () => {
    const resultA = await runWithClubId('club-a', () => buildPlanningAnalytics(fakeDb));
    expect(resultA.analyzedPeriod.days).toBeGreaterThan(0);
    expect(new Date(resultA.analyzedPeriod.from).getTime()).toBeLessThan(new Date(resultA.analyzedPeriod.to).getTime());
  });
});
