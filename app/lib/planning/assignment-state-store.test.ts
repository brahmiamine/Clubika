import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import type { AssignmentContact } from '@/types/match';
import { runWithClubId } from '@/lib/auth/club-context';
import {
  applyOperationalStateToContact,
  assignmentStatePersonKey,
  backfillAssignmentStatesFromSnapshots,
  listAssignmentStatesForEvent,
  listAssignmentStatesForEvents,
  operationalStateFromContact,
  syncAssignmentStatesForRole,
  updateAssignmentReminderStateIfPending,
} from './assignment-state-store';
import type { PlanningEventSnapshot } from './event-store';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function fakeDb(stateRows: Record<string, unknown>[] = []) {
  const calls: QueryCall[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('FROM planning_assignment_state')) return stateRows;
      return [];
    },
  } as unknown as DataSource;
  return { db, calls };
}

const insertsOf = (calls: QueryCall[], verb: string) =>
  calls.filter((call) => call.sql.includes('planning_assignment_state') && call.sql.trimStart().startsWith(verb));

function snapshotWith(
  eventId: string,
  contacts: Partial<AssignmentContact>[],
  eventType: PlanningEventSnapshot['eventType'] = 'amical',
): PlanningEventSnapshot {
  return {
    eventId,
    eventType,
    title: 'AFP – Visiteur',
    date: '23/08/2099',
    time: '15:00',
    durationMinutes: 90,
    location: null,
    planningStatus: 'published',
    event: {
      id: eventId,
      type: 'amical',
      date: '23/08/2099',
      time: '15:00',
      horaireRendezVous: '14:00',
      competition: 'Amical',
      localTeam: 'AFP',
      awayTeam: 'Visiteur',
      venue: 'domicile',
    },
    extras: { id: eventId },
    assignments: {
      arbitre: [],
      encadrant: contacts.map((contact) => ({ nom: 'Jean Dupont', numero: '', ...contact })),
      accompagnateur: [],
    },
  };
}

describe('assignmentStatePersonKey', () => {
  it('préfère l’identifiant de compte quand il est connu', () => {
    expect(assignmentStatePersonKey({ nom: 'Jean Dupont', personId: 7, personType: 'encadrant' }))
      .toBe('id:encadrant:7');
  });

  it('retombe sur le nom normalisé sans identifiant exploitable', () => {
    expect(assignmentStatePersonKey({ nom: '  Jean   DUPONT ' })).toBe('nom:jean   dupont');
    expect(assignmentStatePersonKey({ nom: 'Jean Dupont', personId: 7 })).toBe('nom:jean dupont');
  });
});

describe('operationalStateFromContact / applyOperationalStateToContact', () => {
  it('applique des valeurs par défaut saines à un contact sans état', () => {
    expect(operationalStateFromContact({ nom: 'Jean', numero: '' })).toEqual({
      status: 'pending',
      assignedAt: undefined,
      respondedAt: undefined,
      declineReason: undefined,
      remindersSent: [],
      lastReminderAt: undefined,
      reminderCount: 0,
      attendanceStatus: undefined,
      attendanceUpdatedAt: undefined,
    });
  });

  it('fusionne l’état sur un contact structurel sans toucher à l’identité', () => {
    const contact: AssignmentContact = { nom: 'Jean Dupont', numero: '0600', personId: 7, personType: 'encadrant' };
    const merged = applyOperationalStateToContact(contact, {
      status: 'declined',
      declineReason: 'personal',
      respondedAt: '2026-08-20T10:00:00.000Z',
      remindersSent: ['72h'],
      reminderCount: 1,
      attendanceStatus: 'absent',
      attendanceUpdatedAt: '2026-08-23T18:00:00.000Z',
    });
    expect(merged).toMatchObject({
      nom: 'Jean Dupont',
      numero: '0600',
      personId: 7,
      personType: 'encadrant',
      status: 'declined',
      declineReason: 'personal',
      respondedAt: '2026-08-20T10:00:00.000Z',
      remindersSent: ['72h'],
      reminderCount: 1,
      attendanceStatus: 'absent',
    });
  });

  it('conserve assignedAt du contact si l’état ne le porte pas', () => {
    const contact: AssignmentContact = { nom: 'Jean', numero: '', assignedAt: '2026-08-01T00:00:00.000Z' };
    const merged = applyOperationalStateToContact(contact, { status: 'pending', remindersSent: [], reminderCount: 0 });
    expect(merged.assignedAt).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('syncAssignmentStatesForRole (source opérationnelle, issue #41)', () => {
  it('écrit un upsert par contact, clé stable et état JSON', async () => {
    const { db, calls } = fakeDb();
    await runWithClubId('afp', () =>
      syncAssignmentStatesForRole(db, 'amical', 'm-1', 'encadrant', [
        { nom: 'Jean Dupont', numero: '', personId: 7, personType: 'encadrant', status: 'accepted', respondedAt: '2026-08-20T10:00:00.000Z' },
        { nom: ' Invité ', numero: '' },
      ]));

    const upserts = insertsOf(calls, 'INSERT');
    expect(upserts).toHaveLength(2);
    expect(upserts[0]?.sql).toContain('ON DUPLICATE KEY UPDATE');
    expect(upserts[0]?.params.slice(0, 5)).toEqual(['afp', 'amical', 'm-1', 'encadrant', 'id:encadrant:7']);
    expect(JSON.parse(String(upserts[0]?.params[8]))).toMatchObject({ status: 'accepted' });
    expect(upserts[1]?.params[4]).toBe('nom:invité');
  });
});

describe('updateAssignmentReminderStateIfPending', () => {
  it('n’écrase pas une réponse acceptée arrivée pendant une relance', async () => {
    const calls: QueryCall[] = [];
    const manager = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.includes('FOR UPDATE')) return [{
          clubId: 'afp', eventType: 'amical', eventId: 'm-1', role: 'encadrant',
          personKey: 'id:encadrant:7', personType: 'encadrant', personId: 7,
          personName: 'Jean', state: JSON.stringify({ status: 'accepted', remindersSent: [], reminderCount: 0 }),
          updatedAt: new Date().toISOString(),
        }];
        return [];
      },
    };
    const db = { transaction: async (work: (value: unknown) => Promise<unknown>) => work(manager) } as unknown as DataSource;

    const changed = await updateAssignmentReminderStateIfPending(
      db,
      'amical',
      'm-1',
      'encadrant',
      { nom: 'Jean', numero: '', personType: 'encadrant', personId: 7, remindersSent: ['72h'], reminderCount: 1 },
      'afp',
    );

    expect(changed).toBe(false);
    expect(calls.some((call) => call.sql.trimStart().startsWith('UPDATE planning_assignment_state'))).toBe(false);
  });
});

describe('listAssignmentStatesForEvent(s)', () => {
  it('lit et parse les lignes du store', async () => {
    const { db } = fakeDb([{
      clubId: 'afp',
      eventType: 'amical',
      eventId: 'm-1',
      role: 'encadrant',
      personKey: 'id:encadrant:7',
      personType: 'encadrant',
      personId: 7,
      personName: 'Jean Dupont',
      state: JSON.stringify({ status: 'accepted', remindersSent: ['24h'], reminderCount: 2 }),
      updatedAt: '2026-08-20 10:00:00.000000',
    }]);

    const rows = await runWithClubId('afp', () => listAssignmentStatesForEvent(db, 'amical', 'm-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      personKey: 'id:encadrant:7',
      personId: 7,
      state: { status: 'accepted', remindersSent: ['24h'], reminderCount: 2 },
    });
  });

  it('retombe sur un état pending si le payload est corrompu', async () => {
    const { db } = fakeDb([{ clubId: 'afp', eventType: 'amical', eventId: 'm-1', role: 'encadrant', personKey: 'nom:x', state: '{oops', updatedAt: '2026-08-20 10:00:00' }]);
    const rows = await runWithClubId('afp', () => listAssignmentStatesForEvent(db, 'amical', 'm-1'));
    expect(rows[0]?.state).toEqual({ status: 'pending', remindersSent: [], reminderCount: 0 });
  });

  it('ne lance aucune requête sans clé d’événement', async () => {
    const { db, calls } = fakeDb();
    await expect(listAssignmentStatesForEvents(db, [])).resolves.toEqual([]);
    expect(calls.filter((call) => call.sql.includes('FROM planning_assignment_state'))).toHaveLength(0);
  });
});

describe('backfillAssignmentStatesFromSnapshots (rétro-remplissage, issue #41)', () => {
  it('n’écrase jamais une ligne existante (INSERT IGNORE) et dédoublonne en gardant la source la plus autoritaire', async () => {
    const { db, calls } = fakeDb();
    const live = snapshotWith('m-1', [{ personId: 7, personType: 'encadrant', status: 'accepted' }]);
    const published = snapshotWith('m-1', [{ personId: 7, personType: 'encadrant', status: 'pending' }]);
    const other = snapshotWith('m-2', [{ personId: 8, personType: 'encadrant', status: 'declined', declineReason: 'personal' }]);

    const written = await runWithClubId('afp', () => backfillAssignmentStatesFromSnapshots(db, [live, published, other]));

    expect(written).toBe(2);
    const inserts = insertsOf(calls, 'INSERT');
    expect(inserts).toHaveLength(2);
    expect(inserts.every((call) => call.sql.trimStart().startsWith('INSERT IGNORE'))).toBe(true);
    // La source live (acceptée) prime sur le snapshot publié (pending) pour la même clé.
    const first = JSON.parse(String(inserts[0]?.params[8]));
    expect(first.status).toBe('accepted');
    expect(inserts.map((call) => call.params[4]).sort()).toEqual(['id:encadrant:7', 'id:encadrant:8']);
  });
});
