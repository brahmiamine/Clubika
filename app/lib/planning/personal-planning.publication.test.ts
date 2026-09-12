import { describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import type { SessionUser } from '@/lib/auth/session';
import { runWithClubId } from '@/lib/auth/club-context';
import { listPersonalAssignments } from './personal-planning';

const clubId = process.env.APP_CLUB_ID?.trim() || 'afp';

const user: SessionUser = {
  id: 7,
  clubId,
  email: 'arbitre@example.com',
  nom: 'Jean Dupont',
  accessRole: 'dirigeant',
  planningFunctions: ['arbitre_club'],
  telephone: null,
  indisponibilites: null,
  active: true,
  notifyChannel: 'push',
};

function makeDb(planningStatus: 'draft' | 'published' | undefined): DataSource {
  const rows: Record<string, unknown[]> = {
    MatchOfficial: [],
    MatchAmical: [{
      id: 'amical-1',
      payload: {
        id: 'amical-1',
        type: 'amical',
        date: '23/08/2026',
        time: '15:00',
        competition: 'Amical',
        localTeam: 'AFP 18',
        awayTeam: 'Visiteur',
        venue: 'domicile',
        horaireRendezVous: '14:00',
      },
    }],
    Entrainement: [],
    Plateau: [],
    MatchExtra: [{
      matchId: 'amical-1',
      payload: {
        id: 'amical-1',
        ...(planningStatus ? { planningStatus } : {}),
        arbitreTouche: [{
          nom: 'Jean Dupont',
          numero: '',
          personId: 7,
          personType: 'officiel',
          status: 'pending',
        }],
      },
    }],
  };

  return {
    query: async () => [],
    getRepository: (name: string) => ({
      find: async () => rows[name] ?? [],
      findBy: async () => rows[name] ?? [],
    }),
  } as unknown as DataSource;
}

function makeDbWithPublishedSnapshot(events: unknown[]): DataSource {
  const record = {
    id: `published-planning:${clubId}`,
    clubId,
    kind: 'published-planning',
    eventType: null,
    eventId: null,
    ownerUserId: 1,
    personType: null,
    personId: null,
    payload: JSON.stringify({ schemaVersion: 1, publishedAt: '2026-08-01T00:00:00.000Z', publishedByUserId: 1, events }),
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };

  const tenant = {
    id: clubId,
    name: 'AFP',
    abbreviation: 'AFP',
    description: '',
    logo: '',
    themeMode: 'system',
    primaryColor: '#003287',
    secondaryColor: '#e3ebf7',
    timeZone: 'Europe/Paris',
    matchesUrlKey: '',
    scraperClubName: '',
    featuresJson: '{}',
    smtpHost: null,
    smtpPort: null,
    smtpSecure: false,
    smtpUser: null,
    smtpPasswordEncrypted: null,
    smtpFromEmail: null,
    smtpFromName: null,
    active: true,
  };

  return {
    query: async (sql: string) => {
      if (sql.trim().startsWith('SELECT') && sql.includes('FROM planning_records')) return [record];
      return [];
    },
    getRepository: (name?: string) => {
      if (name === 'ClubTenant') {
        return {
          findOneBy: async () => tenant,
          create: (value: unknown) => value,
          save: async (value: unknown) => value,
        };
      }
      if (name === 'AppMeta') {
        return { findOne: async () => null };
      }
      return { find: async () => [], findBy: async () => [] };
    },
  } as unknown as DataSource;
}

describe('personal planning publication visibility', () => {
  it('conserve visible un événement annulé déjà publié auparavant (issue #40)', async () => {
    const cancelledMatch = {
      eventId: 'amical-2',
      eventType: 'amical',
      title: 'AFP – Visiteur',
      date: '23/08/2026',
      time: '15:00',
      durationMinutes: 90,
      location: 'Stade AFP',
      planningStatus: 'cancelled',
      event: {
        id: 'amical-2', type: 'amical', date: '23/08/2026', time: '15:00',
        horaireRendezVous: '14:00', competition: 'Amical', localTeam: 'AFP', awayTeam: 'Visiteur', venue: 'domicile',
      },
      extras: {
        id: 'amical-2',
        planningStatus: 'cancelled',
        arbitreTouche: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'officiel', status: 'accepted' }],
      },
      assignments: {
        arbitre: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'officiel', status: 'accepted' }],
        encadrant: [],
        accompagnateur: [],
      },
    };

    const assignments = await runWithClubId(clubId, () => listPersonalAssignments(makeDbWithPublishedSnapshot([cancelledMatch]), user));

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({ eventId: 'amical-2', cancelled: true, status: 'accepted' });
  });

  it('réexpose le motif et le commentaire de refus après rechargement (issue #44)', async () => {
    const declinedMatch = {
      eventId: 'amical-3',
      eventType: 'amical',
      title: 'AFP – Visiteur',
      date: '23/08/2026',
      time: '15:00',
      durationMinutes: 90,
      location: 'Stade AFP',
      planningStatus: 'published',
      event: {
        id: 'amical-3', type: 'amical', date: '23/08/2026', time: '15:00',
        competition: 'Amical', localTeam: 'AFP', awayTeam: 'Visiteur', venue: 'domicile',
      },
      extras: {
        id: 'amical-3',
        planningStatus: 'published',
        arbitreTouche: [{
          nom: 'Jean Dupont', numero: '', personId: 7, personType: 'officiel',
          status: 'declined', declineReason: 'work', declineComment: 'astreinte',
        }],
      },
      assignments: {
        arbitre: [{
          nom: 'Jean Dupont', numero: '', personId: 7, personType: 'officiel',
          status: 'declined', declineReason: 'work', declineComment: 'astreinte',
        }],
        encadrant: [],
        accompagnateur: [],
      },
    };

    const assignments = await runWithClubId(clubId, () => listPersonalAssignments(makeDbWithPublishedSnapshot([declinedMatch]), user));

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      eventId: 'amical-3',
      status: 'declined',
      declineReason: 'work',
      declineComment: 'astreinte',
    });
  });


  it('expose toutes les fonctions publiées sans utiliser les fonctions générales du profil (issue #210)', async () => {
    const multiFunctionUser: SessionUser = {
      ...user,
      planningFunctions: ['arbitre_club', 'encadrant', 'accompagnateur'],
    };
    const publishedMatch = {
      eventId: 'amical-multi',
      eventType: 'amical',
      title: 'AFP – Visiteur',
      date: '23/08/2026',
      time: '15:00',
      durationMinutes: 90,
      location: 'Stade AFP',
      planningStatus: 'published',
      event: {
        id: 'amical-multi', type: 'amical', date: '23/08/2026', time: '15:00',
        competition: 'Amical', localTeam: 'AFP', awayTeam: 'Visiteur', venue: 'domicile',
      },
      extras: {
        id: 'amical-multi',
        planningStatus: 'published',
        arbitreTouche: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'officiel', status: 'pending' }],
        contactEncadrants: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'encadrant', status: 'pending' }],
        contactAccompagnateur: [{ nom: 'Autre Personne', numero: '', personId: 99, personType: 'accompagnateur', status: 'pending' }],
      },
      assignments: {
        arbitre: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'officiel', status: 'pending' }],
        encadrant: [{ nom: 'Jean Dupont', numero: '', personId: 7, personType: 'encadrant', status: 'pending' }],
        accompagnateur: [{ nom: 'Autre Personne', numero: '', personId: 99, personType: 'accompagnateur', status: 'pending' }],
      },
    };

    const assignments = await runWithClubId(
      clubId,
      () => listPersonalAssignments(makeDbWithPublishedSnapshot([publishedMatch]), multiFunctionUser),
    );

    expect(assignments).toHaveLength(2);
    expect(assignments.map((assignment) => assignment.role)).toEqual(['arbitre', 'encadrant']);
    expect(assignments.every((assignment) =>
      JSON.stringify(assignment.roles) === JSON.stringify(['arbitre', 'encadrant']),
    )).toBe(true);
    expect(assignments.some((assignment) => assignment.roles.includes('accompagnateur'))).toBe(false);
  });

  it('does not expose a draft event to the assigned person', async () => {
    const assignments = await runWithClubId(clubId, () => listPersonalAssignments(makeDb('draft'), user));
    expect(assignments).toEqual([]);
  });

  it('does not expose legacy events without a global publication snapshot (issue #94)', async () => {
    const assignments = await runWithClubId(clubId, () => listPersonalAssignments(makeDb(undefined), user));
    expect(assignments).toEqual([]);
  });

  it('does not trust a live published flag before the first global publication (issue #94)', async () => {
    const assignments = await runWithClubId(clubId, () => listPersonalAssignments(makeDb('published'), user));
    expect(assignments).toEqual([]);
  });
});
