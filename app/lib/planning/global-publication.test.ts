import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import type { SessionUser } from '@/lib/auth/session';
import type { PlanningEventSnapshot } from './event-store';

const mocks = vi.hoisted(() => ({
  readAppSettings: vi.fn(),
  listPlanningEventSnapshots: vi.fn(),
  savePlanningPublication: vi.fn(),
  getPublishedPlanning: vi.fn(),
  savePublishedPlanning: vi.fn(),
  appendPublishedPlanningHistory: vi.fn(),
  planningPublicationDiff: vi.fn(),
  computePerUserPublicationChanges: vi.fn(),
  logAuditEntry: vi.fn(),
  enqueueContactNotificationIntents: vi.fn(async (
    _db: unknown,
    _contact: unknown,
    _input: unknown,
    _idempotencyKeyBase?: string,
  ) => [] as unknown[]),
  deliverEnqueuedNotifications: vi.fn(async (_db: unknown, _enqueued: unknown[]) => undefined),
  hydratePlanningAssignmentStates: vi.fn(async (_db: unknown, snapshots: PlanningEventSnapshot[]) => snapshots),
  syncAssignmentStatesForRole: vi.fn(),
  vacateDeclinedAssignmentsFromWorkingDraft: vi.fn(async () => 0),
}));

vi.mock('@/lib/settings-store', () => ({ readAppSettings: mocks.readAppSettings }));
vi.mock('@/lib/db/audit-log', () => ({ logAuditEntry: mocks.logAuditEntry }));
vi.mock('@/lib/notifications/service', () => ({
  enqueueContactNotificationIntents: mocks.enqueueContactNotificationIntents,
  deliverEnqueuedNotifications: mocks.deliverEnqueuedNotifications,
}));
vi.mock('./assignment-state-overlay', () => ({
  hydratePlanningAssignmentStates: mocks.hydratePlanningAssignmentStates,
}));
vi.mock('./assignment-state-store', () => ({
  syncAssignmentStatesForRole: mocks.syncAssignmentStatesForRole,
}));
vi.mock('./declined-assignment-draft', () => ({
  vacateDeclinedAssignmentsFromWorkingDraft: mocks.vacateDeclinedAssignmentsFromWorkingDraft,
}));
vi.mock('./event-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./event-store')>();
  return {
    ...actual,
    listPlanningEventSnapshots: mocks.listPlanningEventSnapshots,
    savePlanningPublication: mocks.savePlanningPublication,
  };
});
vi.mock('./published-planning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./published-planning')>();
  return {
    ...actual,
    getPublishedPlanning: mocks.getPublishedPlanning,
    savePublishedPlanning: mocks.savePublishedPlanning,
    appendPublishedPlanningHistory: mocks.appendPublishedPlanningHistory,
    planningPublicationDiff: mocks.planningPublicationDiff,
    computePerUserPublicationChanges: mocks.computePerUserPublicationChanges,
  };
});

import { runWithClubId } from '@/lib/auth/club-context';
import { collectPublicationBlockers, getGlobalPlanningPublicationPreview, publishGlobalPlanning } from './global-publication';

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

const futureDate = formatDate(new Date(Date.now() + 30 * 86_400_000));
const pastDate = formatDate(new Date(Date.now() - 30 * 86_400_000));

function matchSnapshot(id: string, date = futureDate): PlanningEventSnapshot {
  return {
    eventId: id,
    eventType: 'amical',
    title: `AFP – ${id}`,
    date,
    time: '15:00',
    durationMinutes: 90,
    location: 'Stade AFP',
    planningStatus: 'draft',
    event: {
      id,
      type: 'amical',
      date,
      time: '15:00',
      horaireRendezVous: '14:00',
      competition: 'Amical',
      localTeam: 'AFP',
      awayTeam: id,
      venue: 'domicile',
      planningRevision: 0,
    },
    extras: { id, planningRevision: 0 },
    assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
    revision: 0,
  };
}

interface TxState {
  publishedEvents: string[];
  snapshotSaved: boolean;
}

function fakeDb(state: TxState, users: unknown[] = []): DataSource {
  return {
    getRepository: () => ({ find: async () => users }),
    transaction: async <T>(work: (manager: unknown) => Promise<T>) => {
      const local = structuredClone(state);
      const manager = { txState: local };
      const result = await work(manager);
      state.publishedEvents = local.publishedEvents;
      state.snapshotSaved = local.snapshotSaved;
      return result;
    },
  } as unknown as DataSource;
}

const user = {
  id: 7,
  clubId: 'afp',
  accessRole: 'admin',
  planningFunctions: [],
} as unknown as SessionUser;

const diff = {
  current: 2,
  published: 0,
  added: 2,
  modified: 0,
  removed: 0,
  unchanged: 0,
  changed: 2,
  removedEvents: [],
};

const openFeatures = {
  features: {
    publicationReadiness: false,
    assignmentValidation: false,
    requireArbitreForPublication: false,
    requireEncadrantForPublication: false,
    requireAccompagnateurForPublication: false,
  },
};

function mockSuccessfulSave() {
  mocks.savePlanningPublication.mockImplementation(async (manager: { txState: TxState }, snapshot: PlanningEventSnapshot) => {
    manager.txState.publishedEvents.push(snapshot.eventId);
  });
  mocks.savePublishedPlanning.mockImplementation(async (manager: { txState: TxState }, _user: SessionUser, refreshed: PlanningEventSnapshot[], publishedAt: string) => {
    manager.txState.snapshotSaved = true;
    return {
      schemaVersion: 1,
      publishedAt,
      publishedByUserId: user.id,
      events: refreshed,
    };
  });
}

describe('publication globale — atomicité (issue #37)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAppSettings.mockResolvedValue(openFeatures);
    mocks.getPublishedPlanning.mockResolvedValue(null);
    mocks.planningPublicationDiff.mockReturnValue(diff);
    mocks.computePerUserPublicationChanges.mockReturnValue([]);
  });

  it('rollbacke les statuts déjà écrits si un événement échoue avant le snapshot global', async () => {
    const snapshots = [matchSnapshot('a-1'), matchSnapshot('a-2')];
    const state: TxState = { publishedEvents: [], snapshotSaved: false };
    const db = fakeDb(state);

    mocks.listPlanningEventSnapshots.mockResolvedValue(snapshots);
    mocks.savePlanningPublication.mockImplementation(async (manager: { txState: TxState }, snapshot: PlanningEventSnapshot) => {
      manager.txState.publishedEvents.push(snapshot.eventId);
      if (snapshot.eventId === 'a-2') throw new Error('conflit simulé');
    });
    mocks.savePublishedPlanning.mockImplementation(async (manager: { txState: TxState }) => {
      manager.txState.snapshotSaved = true;
      return {
        schemaVersion: 1,
        publishedAt: '2026-09-06T00:00:00.000Z',
        publishedByUserId: user.id,
        events: snapshots,
      };
    });

    await expect(publishGlobalPlanning(db, user)).rejects.toThrow('conflit simulé');

    expect(state).toEqual({ publishedEvents: [], snapshotSaved: false });
    expect(mocks.savePublishedPlanning).not.toHaveBeenCalled();
    // Issue #276 : l'audit et les intentions de notification sont désormais écrits dans
    // la même transaction que le snapshot publié — un rollback de l'un annule les autres,
    // et aucune livraison ne doit jamais être tentée pour une publication qui a échoué.
    expect(mocks.logAuditEntry).not.toHaveBeenCalled();
    expect(mocks.enqueueContactNotificationIntents).not.toHaveBeenCalled();
    expect(mocks.deliverEnqueuedNotifications).not.toHaveBeenCalled();
  });

  it('écrit tous les statuts, le snapshot et l’audit avec le même manager transactionnel (issue #276)', async () => {
    const snapshots = [matchSnapshot('a-1'), matchSnapshot('a-2')];
    const state: TxState = { publishedEvents: [], snapshotSaved: false };
    const db = fakeDb(state);

    mocks.listPlanningEventSnapshots.mockResolvedValue(snapshots);
    mockSuccessfulSave();

    await publishGlobalPlanning(db, user);

    expect(state).toEqual({ publishedEvents: ['a-1', 'a-2'], snapshotSaved: true });
    const firstManager = mocks.savePlanningPublication.mock.calls[0]?.[0];
    expect(mocks.savePlanningPublication.mock.calls[1]?.[0]).toBe(firstManager);
    expect(mocks.savePublishedPlanning.mock.calls[0]?.[0]).toBe(firstManager);
    // L'entrée d'audit doit être écrite avec ce même manager transactionnel, jamais avec
    // le `db` de premier niveau — sinon elle survivrait à un rollback de la publication.
    expect(mocks.logAuditEntry).toHaveBeenCalledTimes(1);
    expect(mocks.logAuditEntry.mock.calls[0]?.[0]).toBe(firstManager);
    // La livraison réelle (réseau), elle, ne doit jamais recevoir le manager transactionnel :
    // elle a lieu après le commit, avec le `db` de premier niveau.
    expect(mocks.deliverEnqueuedNotifications).toHaveBeenCalledTimes(1);
    expect(mocks.deliverEnqueuedNotifications.mock.calls[0]?.[0]).toBe(db);
  });

  it('ne réécrit pas l’état inchangé hydraté avant la transaction', async () => {
    const current = matchSnapshot('stable-1');
    current.assignments.encadrant = [{
      nom: 'Jean', numero: '', personType: 'encadrant', personId: 7, status: 'accepted',
    }];
    const previous = structuredClone(current);
    previous.planningStatus = 'published';
    const state: TxState = { publishedEvents: [], snapshotSaved: false };
    mocks.listPlanningEventSnapshots.mockResolvedValue([current]);
    mocks.getPublishedPlanning.mockResolvedValue({
      schemaVersion: 1,
      publishedAt: '2026-09-01T00:00:00.000Z',
      publishedByUserId: user.id,
      events: [previous],
    });
    mockSuccessfulSave();
    // Jean (personId 7) doit exister et être actif : sinon la publication le signale
    // désormais comme affectation orpheline (issue #273), ce qui n'est pas l'objet de
    // ce test (comportement idempotent de la sauvegarde).
    const activeUsers = [{ id: 7, nom: 'Jean', active: true, planningFunctions: [], indisponibilites: [] }];

    await publishGlobalPlanning(fakeDb(state, activeUsers), user);

    expect(mocks.syncAssignmentStatesForRole).not.toHaveBeenCalled();
  });
});

describe('publication globale — événements sortis de la fenêtre (issue #76)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAppSettings.mockResolvedValue(openFeatures);
    mocks.planningPublicationDiff.mockReturnValue(diff);
    mocks.computePerUserPublicationChanges.mockReturnValue([]);
  });

  it('exclut du diff de notification les événements passés partis en historique', async () => {
    const stillInWindow = { ...matchSnapshot('b-1'), planningStatus: 'published' as const };
    // Événement publié il y a 30 jours : hors fenêtre J-7, il part en historique.
    const agedOut = {
      ...matchSnapshot('old-1', pastDate),
      planningStatus: 'published' as const,
    };
    const snapshots = [matchSnapshot('b-1')];
    const state: TxState = { publishedEvents: [], snapshotSaved: false };
    const db = fakeDb(state);

    mocks.listPlanningEventSnapshots.mockResolvedValue(snapshots);
    mocks.getPublishedPlanning.mockResolvedValue({
      schemaVersion: 1,
      publishedAt: '2026-09-01T00:00:00.000Z',
      publishedByUserId: user.id,
      events: [agedOut, stillInWindow],
    });
    mockSuccessfulSave();

    await publishGlobalPlanning(db, user);

    // L'événement passé est bien versé en historique…
    expect(mocks.appendPublishedPlanningHistory).toHaveBeenCalledTimes(1);
    const agedArg = mocks.appendPublishedPlanningHistory.mock.calls[0]?.[2] as PlanningEventSnapshot[];
    expect(agedArg.map((snapshot) => snapshot.eventId)).toEqual(['old-1']);

    // …mais il est exclu du diff de notification : aucune fausse « Affectation supprimée ».
    expect(mocks.computePerUserPublicationChanges).toHaveBeenCalledTimes(1);
    const [previousArg] = mocks.computePerUserPublicationChanges.mock.calls[0] as [PlanningEventSnapshot[]];
    expect(previousArg.map((snapshot) => snapshot.eventId)).toEqual(['b-1']);
  });
});

describe('publication globale — urgence des notifications (issue #217)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAppSettings.mockResolvedValue(openFeatures);
    mocks.getPublishedPlanning.mockResolvedValue(null);
    mocks.planningPublicationDiff.mockReturnValue(diff);
  });

  it('marque annulation et retrait comme critiques, mais pas ajout ni changement d’horaire', async () => {
    const snapshots = [matchSnapshot('c-1')];
    const state: TxState = { publishedEvents: [], snapshotSaved: false };
    const db = fakeDb(state);
    const contact = (name: string) => ({ nom: name, numero: '', personType: 'encadrant' as const });

    mocks.listPlanningEventSnapshots.mockResolvedValue(snapshots);
    mocks.computePerUserPublicationChanges.mockReturnValue([
      { contact: contact('Cancelled'), eventType: 'amical', eventId: 'c-1', role: 'encadrant', kind: 'cancelled', message: 'Événement annulé' },
      { contact: contact('Removed'), eventType: 'amical', eventId: 'c-1', role: 'encadrant', kind: 'removed', message: 'Affectation supprimée' },
      { contact: contact('Added'), eventType: 'amical', eventId: 'c-1', role: 'encadrant', kind: 'added', message: 'Nouvelle affectation' },
      { contact: contact('Rescheduled'), eventType: 'amical', eventId: 'c-1', role: 'encadrant', kind: 'rescheduled', message: 'Horaire modifié' },
    ]);
    mockSuccessfulSave();

    await publishGlobalPlanning(db, user);

    const urgencyByName = new Map(
      mocks.enqueueContactNotificationIntents.mock.calls.map((call) => {
        const [, contactArg, input] = call as [unknown, { nom: string }, { urgency?: string }];
        return [contactArg.nom, input.urgency] as const;
      }),
    );
    expect(urgencyByName.get('Cancelled')).toBe('critical');
    expect(urgencyByName.get('Removed')).toBe('critical');
    expect(urgencyByName.get('Added')).toBe('normal');
    expect(urgencyByName.get('Rescheduled')).toBe('normal');
  });
});

describe('publication globale — empreintes d’idempotence des notifications (issue #276)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAppSettings.mockResolvedValue(openFeatures);
    mocks.planningPublicationDiff.mockReturnValue(diff);
  });

  it('calcule la même clé d’idempotence pour deux tentatives parties du même état publié précédent', async () => {
    const snapshots = [matchSnapshot('d-1')];
    const contact = { nom: 'Cible', numero: '', personType: 'encadrant' as const };
    const priorPublish = {
      schemaVersion: 1 as const,
      publishedAt: '2026-09-01T00:00:00.000Z',
      publishedByUserId: user.id,
      events: [],
    };

    mocks.listPlanningEventSnapshots.mockResolvedValue(snapshots);
    mocks.getPublishedPlanning.mockResolvedValue(priorPublish);
    mocks.computePerUserPublicationChanges.mockReturnValue([
      { contact, eventType: 'amical', eventId: 'd-1', role: 'encadrant', kind: 'added', message: 'Nouvelle affectation' },
    ]);
    mockSuccessfulSave();

    await publishGlobalPlanning(fakeDb({ publishedEvents: [], snapshotSaved: false }), user);
    const firstKey = mocks.enqueueContactNotificationIntents.mock.calls[0]?.[3];
    expect(firstKey).toBe('publish:2026-09-01T00:00:00.000Z:amical:d-1:cible:added');

    vi.clearAllMocks();
    mocks.readAppSettings.mockResolvedValue(openFeatures);
    mocks.planningPublicationDiff.mockReturnValue(diff);
    mocks.listPlanningEventSnapshots.mockResolvedValue(snapshots);
    mocks.getPublishedPlanning.mockResolvedValue(priorPublish);
    mocks.computePerUserPublicationChanges.mockReturnValue([
      { contact, eventType: 'amical', eventId: 'd-1', role: 'encadrant', kind: 'added', message: 'Nouvelle affectation' },
    ]);
    mockSuccessfulSave();

    // Une seconde tentative (concurrente, ou rejouée après une coupure) partant du même
    // `before` recalcule EXACTEMENT la même clé malgré un `publishedAt` différent pour
    // cette tentative — c'est cette clé qui permet à `enqueueNotificationDelivery` de
    // faire converger les deux tentatives sur la même ligne d'outbox plutôt que de
    // doubler la notification.
    await publishGlobalPlanning(fakeDb({ publishedEvents: [], snapshotSaved: false }), user);
    const secondKey = mocks.enqueueContactNotificationIntents.mock.calls[0]?.[3];
    expect(secondKey).toBe(firstKey);
  });

  it('préfixe la clé des rappels de reconfirmation différemment des changements standards', async () => {
    const current = matchSnapshot('e-1');
    current.assignments.encadrant = [{
      nom: 'Jean', numero: '', personType: 'encadrant', personId: 7, status: 'accepted',
    }];
    const previous = structuredClone(current);
    previous.planningStatus = 'published';
    previous.time = '14:00';
    mocks.listPlanningEventSnapshots.mockResolvedValue([current]);
    mocks.getPublishedPlanning.mockResolvedValue({
      schemaVersion: 1,
      publishedAt: '2026-09-01T00:00:00.000Z',
      publishedByUserId: user.id,
      events: [previous],
    });
    mocks.computePerUserPublicationChanges.mockReturnValue([]);
    mockSuccessfulSave();
    const activeUsers = [{ id: 7, nom: 'Jean', active: true, planningFunctions: [], indisponibilites: [] }];

    await publishGlobalPlanning(fakeDb({ publishedEvents: [], snapshotSaved: false }, activeUsers), user);

    const resetKey = mocks.enqueueContactNotificationIntents.mock.calls
      .map((call) => call[3] as string)
      .find((key) => key.includes(':reconfirm:'));
    expect(resetKey).toBe('publish:2026-09-01T00:00:00.000Z:reconfirm:amical:e-1:encadrant:7');
  });
});

describe('publication globale — idempotence republication (issue #348)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAppSettings.mockResolvedValue(openFeatures);
    mocks.planningPublicationDiff.mockReturnValue({
      current: 1,
      published: 1,
      added: 0,
      modified: 0,
      removed: 0,
      unchanged: 1,
      changed: 0,
      removedEvents: [],
    });
  });

  it('n’enqueue aucune notification quand le diff est vide (republication identique)', async () => {
    const current = matchSnapshot('republish-1');
    current.planningStatus = 'published';
    current.assignments.encadrant = [{
      nom: 'Jean', numero: '', personType: 'encadrant', personId: 7, status: 'accepted',
    }];
    const previous = structuredClone(current);
    const state: TxState = { publishedEvents: [], snapshotSaved: false };
    const activeUsers = [{ id: 7, nom: 'Jean', active: true, planningFunctions: ['encadrant'], indisponibilites: [] }];

    mocks.listPlanningEventSnapshots.mockResolvedValue([current]);
    mocks.getPublishedPlanning.mockResolvedValue({
      schemaVersion: 1,
      publishedAt: '2026-09-01T00:00:00.000Z',
      publishedByUserId: user.id,
      events: [previous],
    });
    mocks.computePerUserPublicationChanges.mockReturnValue([
      {
        contact: { nom: 'Jean', numero: '', personType: 'encadrant', personId: 7 },
        eventType: 'amical',
        eventId: 'republish-1',
        role: 'encadrant',
        kind: 'added',
        message: 'Nouvelle affectation',
      },
    ]);
    mockSuccessfulSave();

    await publishGlobalPlanning(fakeDb(state, activeUsers), user);

    expect(mocks.enqueueContactNotificationIntents).not.toHaveBeenCalled();
    expect(mocks.deliverEnqueuedNotifications).toHaveBeenCalledWith(expect.anything(), []);
  });
});

describe('collectPublicationBlockers — affectation vers un compte inactif (issue #206)', () => {
  it('bloque toujours une affectation vers un compte désactivé, même sans les fonctionnalités optionnelles', () => {
    const snapshot = matchSnapshot('inactive-1');
    snapshot.assignments.encadrant = [{
      nom: 'Ancien Encadrant', numero: '', personType: 'encadrant', personId: 42, status: 'accepted',
    }];

    const blockers = collectPublicationBlockers(
      [snapshot],
      openFeatures as never,
      [{ id: 42, nom: 'Ancien Encadrant', planningFunctions: ['encadrant'], indisponibilites: [], active: false }],
    );

    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      eventId: 'inactive-1',
      detail: expect.stringContaining('n\'est plus un compte actif'),
    });
  });

  it('ne bloque rien pour un compte actif', () => {
    const snapshot = matchSnapshot('active-1');
    snapshot.assignments.encadrant = [{
      nom: 'Encadrant Actif', numero: '', personType: 'encadrant', personId: 7, status: 'accepted',
    }];

    const blockers = collectPublicationBlockers(
      [snapshot],
      openFeatures as never,
      [{ id: 7, nom: 'Encadrant Actif', planningFunctions: ['encadrant'], indisponibilites: [], active: true }],
    );

    expect(blockers).toHaveLength(0);
  });
});

describe('collectPublicationBlockers — affectation vers un compte supprimé (issue #273)', () => {
  it('bloque toujours une affectation vers un personId inexistant, même sans assignmentValidation', () => {
    const snapshot = matchSnapshot('deleted-1');
    snapshot.assignments.arbitre = [{
      nom: 'Compte Supprimé', numero: '', personType: 'officiel', personId: 999, status: 'accepted',
    }];

    // openFeatures désactive assignmentValidation : c'est le seul chemin qui, avant
    // l'issue #273, aurait détecté une référence orpheline via validateAssignmentSet.
    const blockers = collectPublicationBlockers([snapshot], openFeatures as never, []);

    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      eventId: 'deleted-1',
      code: expect.stringContaining('unknown-assignee'),
      detail: expect.stringContaining('n\'existe plus dans le référentiel'),
    });
  });

  it('ne confond pas un personId inexistant avec un compte inactif (messages distincts)', () => {
    const snapshot = matchSnapshot('mixed-1');
    snapshot.assignments.encadrant = [
      { nom: 'Compte Supprimé', numero: '', personType: 'encadrant', personId: 999, status: 'accepted' },
      { nom: 'Compte Désactivé', numero: '', personType: 'encadrant', personId: 42, status: 'accepted' },
    ];

    const blockers = collectPublicationBlockers(
      [snapshot],
      openFeatures as never,
      [{ id: 42, nom: 'Compte Désactivé', planningFunctions: ['encadrant'], indisponibilites: [], active: false }],
    );

    expect(blockers).toHaveLength(2);
    expect(blockers.map((blocker) => blocker.detail).sort()).toEqual([
      'Compte Désactivé n\'est plus un compte actif',
      'Compte Supprimé n\'existe plus dans le référentiel',
    ]);
  });
});

describe('aperçu de publication — matchs officiels du week-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hydratePlanningAssignmentStates.mockImplementation(async (_db: unknown, snapshots: PlanningEventSnapshot[]) => snapshots);
    mocks.vacateDeclinedAssignmentsFromWorkingDraft.mockResolvedValue(0);
  });

  it('exclut les matchs officiels hors week-end du diff, pas les amicaux', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 7, 20, 10, 0, 0));
    mocks.readAppSettings.mockResolvedValue({
      timeZone: 'Europe/Paris',
      features: {
        ...openFeatures.features,
        officialMatchesCurrentWeekendOnly: true,
      },
    });
    mocks.getPublishedPlanning.mockResolvedValue(null);
    mocks.planningPublicationDiff.mockImplementation((current: PlanningEventSnapshot[]) => ({
      ...diff,
      current: current.length,
      added: current.length,
      changed: current.length,
    }));

    const asOfficial = (snapshot: PlanningEventSnapshot): PlanningEventSnapshot => ({
      ...snapshot,
      eventType: 'officiel',
      event: { ...snapshot.event, type: 'officiel' },
    });

    mocks.listPlanningEventSnapshots.mockResolvedValue([
      asOfficial(matchSnapshot('off-weekend', '22/08/2026')),
      asOfficial(matchSnapshot('off-monday', '24/08/2026')),
      matchSnapshot('amical-monday', '24/08/2026'),
    ]);

    try {
      await runWithClubId('afp', () => getGlobalPlanningPublicationPreview(fakeDb({ publishedEvents: [], snapshotSaved: false })));
      const current = mocks.planningPublicationDiff.mock.calls[0]?.[0] as PlanningEventSnapshot[];
      expect(current.map((item) => item.eventId).sort()).toEqual(['amical-monday', 'off-weekend']);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
