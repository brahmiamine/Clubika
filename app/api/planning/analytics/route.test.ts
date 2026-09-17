import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { PlanningAnalytics } from '@/lib/planning/analytics';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getDb: vi.fn(),
  buildPlanningAnalytics: vi.fn(),
  setCurrentClubId: vi.fn(),
}));

vi.mock('@/lib/auth/require', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/db', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/planning/analytics', () => ({ buildPlanningAnalytics: mocks.buildPlanningAnalytics }));
vi.mock('@/lib/auth/club-context', () => ({ setCurrentClubId: mocks.setCurrentClubId }));

import { GET } from './route';

function analyticsFixture(overrides: Partial<PlanningAnalytics> = {}): PlanningAnalytics {
  return {
    events: 2,
    requiredRoles: 4,
    missingRoles: 1,
    assignments: 5,
    respondedAssignments: 4,
    acceptanceRate: 75,
    attendanceRate: 100,
    averageResponseDelayMinutes: 42,
    replacementRate: 25,
    declineRate: 25,
    missingCoverageRate: 25,
    fairnessCoefficient: 0.9,
    workload: [
      { identity: 'encadrant:1', nom: 'Encadrant Un', assignments: 3 },
      { identity: 'officiel:2', nom: 'Officiel Deux', assignments: 2 },
    ],
    analyzedPeriod: {
      days: 180,
      from: '2026-03-19T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    },
    ...overrides,
  };
}

function request() {
  return new NextRequest('http://localhost/api/planning/analytics');
}

describe('GET /api/planning/analytics (issue #16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockResolvedValue({});
  });

  it('refuse l’accès sans authentification (autorisation admin uniquement)', async () => {
    mocks.requireRole.mockResolvedValue({
      error: NextResponse.json({ error: 'Non authentifié' }, { status: 401 }),
    });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mocks.buildPlanningAnalytics).not.toHaveBeenCalled();
    expect(mocks.setCurrentClubId).not.toHaveBeenCalled();
  });

  it('refuse l’accès à un rôle non-admin (dirigeant) — accès strictement réservé aux admins', async () => {
    mocks.requireRole.mockResolvedValue({
      error: NextResponse.json({ error: 'Action non autorisée pour votre rôle' }, { status: 403 }),
    });

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mocks.buildPlanningAnalytics).not.toHaveBeenCalled();
  });

  it('scope le calcul sur le club de l’administrateur authentifié et renvoie ses statistiques', async () => {
    const admin = { id: 1, clubId: 'club-a', accessRole: 'admin' as const };
    mocks.requireRole.mockResolvedValue({ user: admin });
    mocks.buildPlanningAnalytics.mockResolvedValue(analyticsFixture());

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mocks.setCurrentClubId).toHaveBeenCalledWith('club-a');
    // La portée club est posée avant le calcul — jamais après (pas de fuite entre clubs).
    const setClubOrder = mocks.setCurrentClubId.mock.invocationCallOrder[0];
    const buildOrder = mocks.buildPlanningAnalytics.mock.invocationCallOrder[0];
    expect(setClubOrder).toBeDefined();
    expect(buildOrder).toBeDefined();
    expect(setClubOrder as number).toBeLessThan(buildOrder as number);
  });

  it('isole les requêtes de deux clubs différents — jamais de mélange de portée club', async () => {
    const adminA = { id: 1, clubId: 'club-a', accessRole: 'admin' as const };
    const adminB = { id: 2, clubId: 'club-b', accessRole: 'admin' as const };
    const analyticsA = analyticsFixture({ events: 3 });
    const analyticsB = analyticsFixture({ events: 9 });

    mocks.requireRole.mockResolvedValueOnce({ user: adminA });
    mocks.buildPlanningAnalytics.mockResolvedValueOnce(analyticsA);
    const responseA = await GET(request());
    expect(await responseA.json()).toEqual(analyticsA);
    expect(mocks.setCurrentClubId).toHaveBeenNthCalledWith(1, 'club-a');

    mocks.requireRole.mockResolvedValueOnce({ user: adminB });
    mocks.buildPlanningAnalytics.mockResolvedValueOnce(analyticsB);
    const responseB = await GET(request());
    expect(await responseB.json()).toEqual(analyticsB);
    expect(mocks.setCurrentClubId).toHaveBeenNthCalledWith(2, 'club-b');
  });

  it('renvoie une forme minimale : pas de refus/présence/absence nominatifs, une période analysée bornée', async () => {
    mocks.requireRole.mockResolvedValue({ user: { id: 1, clubId: 'club-a', accessRole: 'admin' as const } });
    mocks.buildPlanningAnalytics.mockResolvedValue(analyticsFixture());

    const response = await GET(request());
    const body = await response.json() as PlanningAnalytics;

    expect(body.analyzedPeriod).toEqual({
      days: 180,
      from: '2026-03-19T00:00:00.000Z',
      to: '2026-09-15T00:00:00.000Z',
    });
    for (const item of body.workload) {
      expect(Object.keys(item).sort()).toEqual(['assignments', 'identity', 'nom']);
      expect(item).not.toHaveProperty('declined');
      expect(item).not.toHaveProperty('present');
      expect(item).not.toHaveProperty('absent');
      expect(item).not.toHaveProperty('accepted');
    }
  });

  it('renvoie une erreur 500 sans détail si le calcul échoue', async () => {
    mocks.requireRole.mockResolvedValue({ user: { id: 1, clubId: 'club-a', accessRole: 'admin' as const } });
    mocks.buildPlanningAnalytics.mockRejectedValue(new Error('boom'));

    const response = await GET(request());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Impossible de calculer les statistiques du planning' });
  });
});
