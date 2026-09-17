import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getDb: vi.fn(),
  logAuditEntry: vi.fn(),
  buildAssignmentSuggestions: vi.fn(),
  enrichAssignmentContacts: vi.fn(),
  propagateAssignmentChangesIfPublished: vi.fn(),
  getPlanningEventSnapshot: vi.fn(),
  saveRoleAssignments: vi.fn(),
  planningFeatureGuard: vi.fn(),
  setCurrentClubId: vi.fn(),
}));

vi.mock('@/lib/auth/require', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/db', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/db/audit-log', () => ({ logAuditEntry: mocks.logAuditEntry }));
vi.mock('@/lib/planning/assignment-suggestions', () => ({ buildAssignmentSuggestions: mocks.buildAssignmentSuggestions }));
vi.mock('@/lib/planning/assignment-contacts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/assignment-contacts')>();
  return { ...actual, enrichAssignmentContacts: mocks.enrichAssignmentContacts };
});
vi.mock('@/lib/planning/assignment-propagation', () => ({
  propagateAssignmentChangesIfPublished: mocks.propagateAssignmentChangesIfPublished,
}));
vi.mock('@/lib/planning/event-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/planning/event-store')>();
  return {
    ...actual,
    getPlanningEventSnapshot: mocks.getPlanningEventSnapshot,
    saveRoleAssignments: mocks.saveRoleAssignments,
  };
});
vi.mock('@/lib/planning/feature-guard', () => ({ planningFeatureGuard: mocks.planningFeatureGuard }));
vi.mock('@/lib/auth/club-context', () => ({ setCurrentClubId: mocks.setCurrentClubId }));

import { GET, POST } from './route';
import { PlanningConcurrencyError } from '@/lib/planning/event-store';
import { NextResponse } from 'next/server';

const user = {
  id: 7,
  clubId: 'club-test',
  accessRole: 'admin',
  planningFunctions: [],
  email: 'admin@example.com',
  nom: 'Admin',
};

const snapshot: PlanningEventSnapshot = {
  eventId: 'evt-1',
  eventType: 'entrainement',
  title: 'Entraînement',
  date: '20/09/2026',
  time: '10:00',
  durationMinutes: 90,
  location: 'Terrain A',
  planningStatus: 'published',
  event: {
    id: 'evt-1',
    type: 'entrainement',
    date: '20/09/2026',
    time: '10:00',
    lieu: 'Terrain A',
    encadrants: [],
    planningStatus: 'published',
  },
  extras: null,
  assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
  revision: 0,
};

const candidate = {
  personId: 42,
  personType: 'encadrant' as const,
  nom: 'Candidat Sentinelle',
  telephone: '0600000000',
  score: 100,
  load30Days: 0,
  upcomingLoad: 0,
  reasons: ['Disponible sur le créneau', 'Aucun conflit détecté'],
};

function getRequest(params: Record<string, string>) {
  const url = new URL('http://localhost/api/planning/auto-assign');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new NextRequest(url);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/planning/auto-assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('planning/auto-assign — suggestions en lecture seule puis confirmation explicite (issue #15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ user });
    mocks.planningFeatureGuard.mockResolvedValue(null);
    mocks.getPlanningEventSnapshot.mockResolvedValue(snapshot);
    mocks.buildAssignmentSuggestions.mockResolvedValue([candidate]);
    mocks.enrichAssignmentContacts.mockResolvedValue([{
      nom: candidate.nom,
      numero: candidate.telephone,
      personId: candidate.personId,
      personType: candidate.personType,
      status: 'pending',
    }]);
    mocks.saveRoleAssignments.mockResolvedValue(1);
    mocks.propagateAssignmentChangesIfPublished.mockResolvedValue(false);
    mocks.getDb.mockResolvedValue({});
  });

  describe('GET — suggestions', () => {
    it('renvoie les candidats avec score et raisons sans jamais écrire le planning', async () => {
      const response = await GET(getRequest({ eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant' }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.suggestions).toEqual([candidate]);
      expect(payload.suggestions[0].reasons.length).toBeGreaterThan(0);
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
      expect(mocks.enrichAssignmentContacts).not.toHaveBeenCalled();
      expect(mocks.propagateAssignmentChangesIfPublished).not.toHaveBeenCalled();
      expect(mocks.logAuditEntry).not.toHaveBeenCalled();
    });

    it('renvoie 400 sur une requête de suggestion invalide, sans toucher au planning', async () => {
      const response = await GET(getRequest({ eventType: 'entrainement', eventId: '', role: 'encadrant' }));
      expect(response.status).toBe(400);
      expect(mocks.getPlanningEventSnapshot).not.toHaveBeenCalled();
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
    });

    it('respecte le flag autoAssignment désactivé (409) sans écrire', async () => {
      mocks.planningFeatureGuard.mockResolvedValue(NextResponse.json({ error: 'désactivé' }, { status: 409 }));
      const response = await GET(getRequest({ eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant' }));
      expect(response.status).toBe(409);
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
    });
  });

  describe('POST — confirmation', () => {
    it('refuse 400 quand personId est absent : aucune affectation implicite du premier candidat', async () => {
      const response = await POST(postRequest({ eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant' }));
      const payload = await response.json();

      expect(response.status).toBe(400);
      expect(payload.error).toMatch(/personId/);
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
      expect(mocks.enrichAssignmentContacts).not.toHaveBeenCalled();
      expect(mocks.logAuditEntry).not.toHaveBeenCalled();
    });

    it('refuse 400 quand personId n’est pas un identifiant valide (0, négatif, non entier)', async () => {
      for (const invalid of [0, -1, 1.5, 'abc']) {
        const response = await POST(postRequest({
          eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: invalid,
        }));
        expect(response.status).toBe(400);
      }
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
    });

    it('confirme l’affectation quand personId désigne un candidat toujours éligible', async () => {
      const response = await POST(postRequest({
        eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42,
      }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.assigned.personId).toBe(42);
      expect(mocks.saveRoleAssignments).toHaveBeenCalledTimes(1);
      // Revalide à l'instant de la confirmation plutôt que de faire confiance à un calcul antérieur.
      expect(mocks.buildAssignmentSuggestions).toHaveBeenCalledWith(expect.anything(), snapshot, 'encadrant', 50);
      expect(mocks.logAuditEntry).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        user,
        action: 'auto-assign',
        after: expect.objectContaining({ score: candidate.score }),
      }));
    });

    it('journalise uniquement l’acteur et la personne choisie, pas les autres candidats évalués', async () => {
      mocks.buildAssignmentSuggestions.mockResolvedValue([
        candidate,
        { ...candidate, personId: 99, nom: 'Autre Candidat', score: 80 },
      ]);
      await POST(postRequest({ eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42 }));

      const call = mocks.logAuditEntry.mock.calls[0]?.[1];
      const serialized = JSON.stringify(call.after);
      expect(serialized).not.toContain('99');
      expect(serialized).not.toContain('Autre Candidat');
    });

    it('refuse 409 quand personId ne fait plus partie des suggestions revalidées (indisponibilité/conflit/éligibilité apparus entre-temps)', async () => {
      // Le candidat visé n'est plus dans la liste recalculée au moment de la confirmation :
      // il est devenu indisponible, en conflit, ou n'est plus éligible (issue #15).
      mocks.buildAssignmentSuggestions.mockResolvedValue([]);
      const response = await POST(postRequest({
        eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42,
      }));

      expect(response.status).toBe(409);
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
      expect(mocks.logAuditEntry).not.toHaveBeenCalled();
    });

    it('refuse 409 sous concurrence : une confirmation concurrente sur le même événement ne remplace jamais silencieusement l’autre', async () => {
      mocks.saveRoleAssignments.mockRejectedValue(new PlanningConcurrencyError());
      const response = await POST(postRequest({
        eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42,
      }));

      expect(response.status).toBe(409);
      expect(mocks.logAuditEntry).not.toHaveBeenCalled();
    });

    it('refuse 409 quand le rôle est déjà couvert sans force=true', async () => {
      mocks.getPlanningEventSnapshot.mockResolvedValue({
        ...snapshot,
        assignments: { ...snapshot.assignments, encadrant: [{ nom: 'Déjà affecté', numero: '', status: 'accepted' }] },
      });
      const response = await POST(postRequest({
        eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42,
      }));

      expect(response.status).toBe(409);
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
    });

    it('permet force=true pour ajouter un second candidat sur un rôle déjà couvert', async () => {
      mocks.getPlanningEventSnapshot.mockResolvedValue({
        ...snapshot,
        assignments: { ...snapshot.assignments, encadrant: [{ nom: 'Déjà affecté', numero: '', status: 'accepted' }] },
      });
      const response = await POST(postRequest({
        eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42, force: true,
      }));

      expect(response.status).toBe(200);
      expect(mocks.saveRoleAssignments).toHaveBeenCalledTimes(1);
    });

    it('respecte le flag autoAssignment désactivé (409) sans écrire', async () => {
      mocks.planningFeatureGuard.mockResolvedValue(NextResponse.json({ error: 'désactivé' }, { status: 409 }));
      const response = await POST(postRequest({
        eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42,
      }));
      expect(response.status).toBe(409);
      expect(mocks.saveRoleAssignments).not.toHaveBeenCalled();
    });

    it('marque l’événement déjà publié `modified` via la propagation standard', async () => {
      const response = await POST(postRequest({
        eventType: 'entrainement', eventId: 'evt-1', role: 'encadrant', personId: 42,
      }));

      expect(response.status).toBe(200);
      expect(mocks.propagateAssignmentChangesIfPublished).toHaveBeenCalledWith(
        expect.anything(),
        user.clubId,
        snapshot,
        snapshot.assignments.encadrant,
        expect.any(Array),
      );
    });
  });
});
