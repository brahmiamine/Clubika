import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import type { SessionUser } from '@/lib/auth/session';
import { runWithClubId } from '@/lib/auth/club-context';
import {
  assignedUserIdsFromSnapshot,
  canCommentOnPlanningEvent,
  canDeletePostEventReport,
  canReadPlanningEventWorkspace,
  isAssignedToPlanningEvent,
  personalPlanningAccessUser,
  resolvePlanningEventForAccess,
} from './event-access';
import type { PlanningEventSnapshot } from './event-store';

const admin: SessionUser = {
  id: 1,
  clubId: 'afp',
  email: 'admin@example.com',
  nom: 'Admin',
  accessRole: 'admin',
  planningFunctions: [],
  telephone: null,
  indisponibilites: null,
  active: true,
  notifyChannel: 'push',
};

const adminEncadrant: SessionUser = {
  ...admin,
  id: 7,
  email: 'admin-encadrant@example.com',
  nom: 'Jean Dupont',
  accessRole: 'admin',
  planningFunctions: ['encadrant'],
};

const encadrant: SessionUser = {
  id: 7,
  clubId: 'afp',
  email: 'encadrant@example.com',
  nom: 'Jean Dupont',
  accessRole: 'dirigeant',
  planningFunctions: ['encadrant'],
  telephone: null,
  indisponibilites: null,
  active: true,
  notifyChannel: 'push',
};

const outsider: SessionUser = {
  id: 8,
  clubId: 'afp',
  email: 'outsider@example.com',
  nom: 'Autre Personne',
  accessRole: 'dirigeant',
  planningFunctions: ['encadrant'],
  telephone: null,
  indisponibilites: null,
  active: true,
  notifyChannel: 'push',
};

const liveEntrainement = {
  id: 'entrainement-1',
  payload: {
    id: 'entrainement-1',
    type: 'entrainement',
    date: '23/08/2026',
    time: '18:00',
    planningStatus: 'published',
    // Le brouillon retire Jean Dupont sans republier.
    encadrants: [],
  },
};

function makeDb(publishedRecordRow: Record<string, unknown> | null): DataSource {
  return {
    query: async (sql: string) => {
      if (sql.includes('CREATE TABLE')) return [];
      if (sql.includes('FROM planning_records')) {
        return publishedRecordRow ? [publishedRecordRow] : [];
      }
      return [];
    },
    getRepository: (name: string) => ({
      findBy: async () => (name === 'Entrainement' ? [liveEntrainement] : []),
      findOneBy: async () => (name === 'Entrainement' ? liveEntrainement : null),
    }),
  } as unknown as DataSource;
}

function publishedRecordRow(events: unknown[]): Record<string, unknown> {
  return {
    id: 'published-planning:afp',
    clubId: 'afp',
    kind: 'published-planning',
    eventType: null,
    eventId: null,
    ownerUserId: 1,
    personType: null,
    personId: null,
    payload: JSON.stringify({
      schemaVersion: 1,
      publishedAt: '2026-08-01T00:00:00.000Z',
      publishedByUserId: 1,
      events,
    }),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

const publishedSnapshotWithEncadrant = {
  eventId: 'entrainement-1',
  eventType: 'entrainement',
  title: 'Entraînement',
  date: '23/08/2026',
  time: '18:00',
  durationMinutes: 90,
  location: null,
  planningStatus: 'published',
  event: { id: 'entrainement-1', type: 'entrainement', date: '23/08/2026', time: '18:00', planningStatus: 'published' },
  extras: null,
  assignments: {
    arbitre: [],
    encadrant: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'encadrant', status: 'pending' }],
    accompagnateur: [],
  },
};

function workspaceSnapshot(status: PlanningEventSnapshot['planningStatus']): PlanningEventSnapshot {
  return {
    eventId: 'm-1',
    eventType: 'amical',
    title: 'AFP – Visiteur',
    date: '23/08/2026',
    time: '15:00',
    durationMinutes: 90,
    location: 'Stade AFP',
    planningStatus: status,
    event: {
      id: 'm-1',
      type: 'amical',
      date: '23/08/2026',
      time: '15:00',
      horaireRendezVous: '14:00',
      competition: 'Amical',
      localTeam: 'AFP',
      awayTeam: 'Visiteur',
      venue: 'domicile',
    },
    extras: { id: 'm-1' },
    assignments: {
      arbitre: [],
      encadrant: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'encadrant', status: 'accepted' }],
      accompagnateur: [],
    },
  };
}

describe('resolvePlanningEventForAccess', () => {
  it('always resolves the live draft for an admin, published or not', async () => {
    const db = makeDb(publishedRecordRow([publishedSnapshotWithEncadrant]));
    const snapshot = await runWithClubId('afp', () =>
      resolvePlanningEventForAccess(db, admin, 'entrainement', 'entrainement-1'));
    expect(snapshot?.assignments.encadrant).toEqual([]);
  });

  it('resolves the published snapshot for a personal account, even if the live draft has since been edited', async () => {
    const db = makeDb(publishedRecordRow([publishedSnapshotWithEncadrant]));
    const snapshot = await runWithClubId('afp', () =>
      resolvePlanningEventForAccess(db, encadrant, 'entrainement', 'entrainement-1'));
    expect(snapshot).not.toBeNull();
    expect(snapshot?.assignments.encadrant[0]?.personId).toBe(7);
  });

  it('does not grant a personal account access to an event only present in the draft', async () => {
    const db = makeDb(publishedRecordRow([]));
    const snapshot = await runWithClubId('afp', () =>
      resolvePlanningEventForAccess(db, encadrant, 'entrainement', 'entrainement-1'));
    expect(snapshot).toBeNull();
  });

  it('returns no event for a personal account before the first global publication (issue #94)', async () => {
    const db = makeDb(null);
    const snapshot = await runWithClubId('afp', () =>
      resolvePlanningEventForAccess(db, encadrant, 'entrainement', 'entrainement-1'));
    expect(snapshot).toBeNull();
  });
});

describe('accès à l’espace d’un événement annulé (issue #80)', () => {
  it('un affecté garde l’accès en lecture à l’espace d’un événement annulé', () => {
    expect(canReadPlanningEventWorkspace(encadrant, workspaceSnapshot('cancelled'))).toBe(true);
  });

  it('un affecté ne peut plus commenter sur un événement annulé', () => {
    expect(canCommentOnPlanningEvent(encadrant, workspaceSnapshot('cancelled'))).toBe(false);
    expect(canCommentOnPlanningEvent(encadrant, workspaceSnapshot('published'))).toBe(true);
  });

  it('un non-affecté n’a toujours pas accès, même en lecture', () => {
    expect(canReadPlanningEventWorkspace(outsider, workspaceSnapshot('cancelled'))).toBe(false);
    expect(canReadPlanningEventWorkspace(outsider, workspaceSnapshot('published'))).toBe(false);
  });

  it('un brouillon non publié reste invisible pour un compte personnel', () => {
    expect(canReadPlanningEventWorkspace(encadrant, workspaceSnapshot('draft'))).toBe(false);
  });

  it('un admin conserve tous les droits sur un événement annulé', () => {
    expect(canReadPlanningEventWorkspace(admin, workspaceSnapshot('cancelled'))).toBe(true);
    expect(canCommentOnPlanningEvent(admin, workspaceSnapshot('cancelled'))).toBe(true);
  });
});

describe('multi-rôles admin + terrain (issue #85)', () => {
  it('reconnaît une affectation terrain même si le compte est aussi admin', () => {
    expect(isAssignedToPlanningEvent(adminEncadrant, publishedSnapshotWithEncadrant as never)).toBe(true);
  });

  it('ne considère pas un admin pur comme personne terrain affectée', () => {
    expect(isAssignedToPlanningEvent(admin, publishedSnapshotWithEncadrant as never)).toBe(false);
  });
});

describe('personalPlanningAccessUser', () => {
  it('retire la capacité admin dans le scope personnel tout en gardant les fonctions', () => {
    const personal = personalPlanningAccessUser(adminEncadrant);
    expect(personal?.accessRole).toBe('dirigeant');
    expect(personal?.planningFunctions).toEqual(['encadrant']);
  });

  it('refuse un admin sans fonction opérationnelle', () => {
    expect(personalPlanningAccessUser(admin)).toBeNull();
  });
});

describe('assignedUserIdsFromSnapshot — chat événement', () => {
  it('n’inclut que les comptes ayant accepté l’affectation', () => {
    const snapshot = {
      ...publishedSnapshotWithEncadrant,
      assignments: {
        arbitre: [{ nom: 'Arbitre', numero: '', personId: 10, personType: 'officiel' as const, status: 'pending' as const }],
        encadrant: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'encadrant' as const, status: 'accepted' as const }],
        accompagnateur: [{ nom: 'Refusé', numero: '', personId: 11, personType: 'accompagnateur' as const, status: 'declined' as const }],
      },
    } as PlanningEventSnapshot;
    const users = [
      { id: 7, nom: 'Jean Dupont' },
      { id: 10, nom: 'Arbitre' },
      { id: 11, nom: 'Refusé' },
    ] as never;

    expect(assignedUserIdsFromSnapshot(snapshot, users)).toEqual([7]);
  });
});

describe('canDeletePostEventReport (issue #8)', () => {
  it('autorise l’auteur et l’admin, pas un pair', () => {
    expect(canDeletePostEventReport(encadrant, { ownerUserId: 7 })).toBe(true);
    expect(canDeletePostEventReport(admin, { ownerUserId: 7 })).toBe(true);
    expect(canDeletePostEventReport(outsider, { ownerUserId: 7 })).toBe(false);
  });
});
