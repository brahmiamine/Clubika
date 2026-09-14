import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClubIndisponibilitesList } from './ClubIndisponibilitesList';
import type { ClubIndisponibiliteRow } from '@/lib/indisponibilites/club-listing';

function row(overrides: Partial<ClubIndisponibiliteRow> & Pick<ClubIndisponibiliteRow, 'id' | 'userName' | 'type' | 'temporalStatus'>): ClubIndisponibiliteRow {
  return {
    userId: 1,
    indisponibiliteId: overrides.id.includes(':') ? overrides.id.split(':').slice(1).join(':') : overrides.id,
    planningFunctions: ['arbitre_club'],
    planningFunctionLabels: ['Arbitre club'],
    typeLabel: overrides.type === 'time-slot' ? 'Créneau horaire' : 'Journée / période',
    dateStart: '01/10/2026',
    dateEnd: '03/10/2026',
    startTime: null,
    endTime: null,
    temporalLabel: overrides.temporalStatus === 'current' ? 'En cours' : overrides.temporalStatus === 'past' ? 'Passée' : 'Future',
    startAtMs: 0,
    endAtMs: 1,
    label: overrides.type === 'time-slot' ? '20/09/2026 (09:00 → 11:00)' : 'Du 01/10/2026 au 03/10/2026 (journées)',
    reviewStatus: 'accepted',
    reviewLabel: 'Acceptée',
    reviewComment: null,
    ...overrides,
  };
}

describe('ClubIndisponibilitesList (issue #320)', () => {
  it('affiche une période, un créneau horaire et l’état vide', () => {
    const populated = renderToStaticMarkup(
      <ClubIndisponibilitesList
        items={[
          row({
            id: '1:range',
            userName: 'Alice Dupont',
            type: 'day-range',
            temporalStatus: 'current',
            planningFunctions: ['arbitre_club', 'encadrant'],
            planningFunctionLabels: ['Arbitre club', 'Encadrant'],
            reviewStatus: 'pending',
            reviewLabel: 'En attente',
          }),
          row({
            id: '1:slot',
            userName: 'Alice Dupont',
            type: 'time-slot',
            temporalStatus: 'future',
            dateStart: '20/09/2026',
            dateEnd: '20/09/2026',
            startTime: '09:00',
            endTime: '11:00',
          }),
        ]}
        onReview={() => undefined}
      />,
    );

    expect(populated).toContain('Alice Dupont');
    expect(populated).toContain('Arbitre club, Encadrant');
    expect(populated).toContain('Journée / période');
    expect(populated).toContain('Créneau horaire');
    expect(populated).toContain('09:00');
    expect(populated).toContain('11:00');
    expect(populated).toContain('En cours');
    expect(populated).toContain('Future');
    expect(populated).toContain('En attente');
    expect(populated).toContain('Accepter');
    expect(populated).toContain('Refuser');
    expect(populated).not.toContain('Motif visible par le dirigeant');
    expect(populated).not.toContain('Blessure');

    const empty = renderToStaticMarkup(<ClubIndisponibilitesList items={[]} />);
    expect(empty).toContain('Aucune indisponibilité enregistrée pour ce club.');
    expect(empty).not.toContain('Journée / période');
  });
});
