import { describe, expect, it } from 'vitest';
import {
  buildPersonalPlanningStats,
  groupPersonalAssignmentsByEvent,
  type PersonalAssignment,
  type PersonalAssignmentRole,
} from './personal-planning';

/**
 * Tests de l'issue #281 : un dirigeant tenant plusieurs fonctions sur le même événement
 * (ex. Arbitre club + Encadrant) doit être regroupé en une seule carte événement, chaque
 * fonction conservant son statut et sa réponse propres, et les métriques « événement »
 * (Total événements, À venir, Historique) ne doivent pas compter le même événement
 * plusieurs fois — à la différence des métriques « affectation » (Total affectations,
 * En attente, Acceptées, Refusées), qui restent par fonction.
 */
function makeAssignment(overrides: Partial<PersonalAssignment> & { role: PersonalAssignmentRole }): PersonalAssignment {
  return {
    assignmentId: `amical:evt-1:${overrides.role}`,
    eventId: 'evt-1',
    eventType: 'amical',
    roles: [overrides.role],
    status: 'pending',
    attendanceStatus: 'unknown',
    respondedAt: null,
    declineReason: null,
    declineComment: null,
    date: '23/08/2999',
    time: '15:00',
    durationMinutes: 90,
    title: 'AFP – Visiteur',
    categorie: 'Seniors',
    lieu: 'Stade AFP',
    adresse: null,
    itineraryLink: null,
    rendezVous: '14:00',
    seriesId: null,
    confirmed: null,
    cancelled: false,
    ...overrides,
  };
}

describe('groupPersonalAssignmentsByEvent (issue #281)', () => {
  it('regroupe une seule fonction sur un événement en une carte avec une fonction', () => {
    const assignments = [makeAssignment({ role: 'arbitre' })];

    const events = groupPersonalAssignmentsByEvent(assignments);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventKey: 'amical:evt-1', eventId: 'evt-1', eventType: 'amical' });
    expect(events[0]!.functions).toHaveLength(1);
    expect(events[0]!.functions.map((fn) => fn.assignmentId)).toEqual(['amical:evt-1:arbitre']);
  });

  it('regroupe deux fonctions sur le même événement en une seule carte, statuts indépendants', () => {
    const assignments = [
      makeAssignment({ role: 'arbitre', assignmentId: 'amical:evt-1:arbitre', status: 'pending' }),
      makeAssignment({ role: 'encadrant', assignmentId: 'amical:evt-1:encadrant', status: 'accepted' }),
    ];

    const events = groupPersonalAssignmentsByEvent(assignments);

    expect(events).toHaveLength(1);
    expect(events[0]!.functions).toHaveLength(2);
    expect(events[0]!.functions.map((fn) => ({ role: fn.roles[0], status: fn.status }))).toEqual([
      { role: 'arbitre', status: 'pending' },
      { role: 'encadrant', status: 'accepted' },
    ]);
  });

  it('regroupe trois fonctions sur le même événement en une seule carte, statuts indépendants', () => {
    const assignments = [
      makeAssignment({ role: 'arbitre', assignmentId: 'amical:evt-1:arbitre', status: 'pending' }),
      makeAssignment({ role: 'encadrant', assignmentId: 'amical:evt-1:encadrant', status: 'accepted' }),
      makeAssignment({
        role: 'accompagnateur',
        assignmentId: 'amical:evt-1:accompagnateur',
        status: 'declined',
        declineReason: 'work',
        declineComment: null,
      }),
    ];

    const events = groupPersonalAssignmentsByEvent(assignments);

    expect(events).toHaveLength(1);
    expect(events[0]!.functions).toHaveLength(3);
    expect(events[0]!.functions.map((fn) => fn.status)).toEqual(['pending', 'accepted', 'declined']);
    expect(events[0]!.functions[2]).toMatchObject({ declineReason: 'work', declineComment: null });
  });

  it('ne regroupe pas des fonctions appartenant à des événements distincts', () => {
    const assignments = [
      makeAssignment({ role: 'arbitre', eventId: 'evt-1', assignmentId: 'amical:evt-1:arbitre' }),
      makeAssignment({ role: 'arbitre', eventId: 'evt-2', assignmentId: 'amical:evt-2:arbitre', title: 'AFP – Autre' }),
    ];

    const events = groupPersonalAssignmentsByEvent(assignments);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.eventKey)).toEqual(['amical:evt-1', 'amical:evt-2']);
  });

  it("distingue deux événements de même type mais d'eventId différent", () => {
    const assignments = [
      makeAssignment({ role: 'arbitre', eventType: 'officiel', eventId: 'evt-1', assignmentId: 'officiel:evt-1:arbitre' }),
      makeAssignment({ role: 'arbitre', eventType: 'officiel', eventId: 'evt-9', assignmentId: 'officiel:evt-9:arbitre' }),
    ];

    const events = groupPersonalAssignmentsByEvent(assignments);

    expect(events.map((event) => event.eventKey)).toEqual(['officiel:evt-1', 'officiel:evt-9']);
  });
});

describe('buildPersonalPlanningStats (issue #281)', () => {
  it("compte un événement multi-fonctions une seule fois dans les métriques d'événement", () => {
    const assignments = [
      makeAssignment({ role: 'arbitre', assignmentId: 'amical:evt-1:arbitre', status: 'pending' }),
      makeAssignment({ role: 'encadrant', assignmentId: 'amical:evt-1:encadrant', status: 'accepted' }),
      makeAssignment({ role: 'accompagnateur', assignmentId: 'amical:evt-1:accompagnateur', status: 'declined', declineReason: 'work' }),
    ];

    const stats = buildPersonalPlanningStats(assignments, 'UTC');

    // Métriques « événement » : un seul événement, malgré trois fonctions.
    expect(stats.totalEvents).toBe(1);
    expect(stats.amical).toBe(1);
    expect(stats.upcomingEvents).toBe(1);
    expect(stats.pastEvents).toBe(0);

    // Métriques « affectation » : une par fonction, statuts non conflés.
    expect(stats.totalAssignments).toBe(3);
    expect(stats.pending).toBe(1);
    expect(stats.accepted).toBe(1);
    expect(stats.declined).toBe(1);
  });

  it('distingue les événements passés/à venir sans les compter en double pour un dirigeant multi-fonctions', () => {
    const upcoming = [
      makeAssignment({ role: 'arbitre', eventId: 'evt-future', assignmentId: 'amical:evt-future:arbitre', date: '23/08/2999', time: '15:00' }),
      makeAssignment({ role: 'encadrant', eventId: 'evt-future', assignmentId: 'amical:evt-future:encadrant', date: '23/08/2999', time: '15:00' }),
    ];
    const past = [
      makeAssignment({ role: 'arbitre', eventId: 'evt-past', assignmentId: 'amical:evt-past:arbitre', date: '23/08/2000', time: '15:00', status: 'accepted' }),
    ];

    const stats = buildPersonalPlanningStats([...upcoming, ...past], 'UTC');

    expect(stats.totalEvents).toBe(2);
    expect(stats.totalAssignments).toBe(3);
    expect(stats.upcomingEvents).toBe(1);
    expect(stats.pastEvents).toBe(1);
  });

  it('remonte à zéro sans affectation', () => {
    const stats = buildPersonalPlanningStats([], 'UTC');
    expect(stats).toMatchObject({ totalEvents: 0, totalAssignments: 0, upcomingEvents: 0, pastEvents: 0 });
  });
});
