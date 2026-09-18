import { describe, expect, it } from 'vitest';
import type { PlanningEventSnapshot } from './event-store';
import type { AssignmentStateRow } from './assignment-state-store';
import { applyAssignmentStatesToSnapshots } from './assignment-state-overlay';

function snapshot(): PlanningEventSnapshot {
  const contact = {
    nom: 'Jean Dupont',
    numero: '0600000000',
    personId: 7,
    personType: 'encadrant' as const,
    status: 'pending' as const,
  };
  return {
    eventId: 'training-1',
    eventType: 'entrainement',
    title: 'Entraînement U15',
    date: '23/08/2099',
    time: '18:00',
    durationMinutes: 90,
    location: 'Stade AFP',
    planningStatus: 'published',
    event: {
      id: 'training-1',
      type: 'entrainement',
      date: '23/08/2099',
      time: '18:00',
      lieu: 'Stade AFP',
      encadrants: [contact],
    },
    extras: null,
    assignments: { arbitre: [], encadrant: [contact], accompagnateur: [] },
  };
}

describe('applyAssignmentStatesToSnapshots', () => {
  it('hydrate les affectations et la projection événement sans lire le brouillon live', () => {
    const row: AssignmentStateRow = {
      clubId: 'afp',
      eventType: 'entrainement',
      eventId: 'training-1',
      role: 'encadrant',
      personKey: 'id:encadrant:7',
      personType: 'encadrant',
      personId: 7,
      personName: 'Jean Dupont',
      state: {
        status: 'declined',
        respondedAt: '2026-09-07T08:00:00.000Z',
        declineReason: 'personal',
        declineComment: 'Indisponible',
        remindersSent: ['72h'],
        reminderCount: 1,
      },
      updatedAt: new Date('2026-09-07T08:00:00.000Z'),
    };

    const hydrated = applyAssignmentStatesToSnapshots([snapshot()], [row])[0]!;
    expect(hydrated.assignments.encadrant[0]).toMatchObject({
      status: 'declined',
      declineReason: 'personal',
      reminderCount: 1,
    });
    expect(hydrated.assignments.encadrant[0]).not.toHaveProperty('declineComment');
    expect((hydrated.event as { encadrants?: unknown[] }).encadrants?.[0]).toMatchObject({
      status: 'declined',
    });
  });

  it("préserve la structure quand aucune ligne opérationnelle n'existe encore", () => {
    const source = snapshot();
    expect(applyAssignmentStatesToSnapshots([source], [])[0]).toEqual(source);
  });
});
