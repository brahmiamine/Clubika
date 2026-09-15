import { describe, expect, it } from 'vitest';
import type { UserReferenceReport } from '@/lib/planning/user-references';
import { ANONYMIZED_DISPLAY_NAME, closedAccountEmail, isClosedAccount } from './constants';
import { accountClosurePreview, closureSummaryHasPii } from './policy';
import { anonymizeAssignmentContact, anonymizeOperationalPayload, anonymizePlanningSnapshot } from './anonymize';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';

describe('account-closure policy (issue #11)', () => {
  it('conserve le stub et documente le chat sans inventer de base légale', () => {
    const references: UserReferenceReport = {
      referenced: true,
      reasons: ['participe à une conversation de chat', 'affecté à un événement du planning (brouillon)'],
    };
    const preview = accountClosurePreview(references, true);
    expect(preview.displayName).toBe(ANONYMIZED_DISPLAY_NAME);
    expect(preview.retained.map((item) => item.category)).toEqual([
      'stub-row',
      'chat-message-bodies',
      'planning-history',
      'authored-operational-records',
    ]);
    expect(preview.retained.every((item) => item.kept)).toBe(true);
    expect(preview.retained.some((item) => item.justification.includes('#12'))).toBe(true);
    expect(closureSummaryHasPii(preview)).toBe(false);
  });

  it('ne marque pas le chat comme conservé sans participation', () => {
    const preview = accountClosurePreview({ referenced: false, reasons: [] }, false);
    expect(preview.retained.find((item) => item.category === 'chat-message-bodies')?.kept).toBe(false);
    expect(preview.retained.find((item) => item.category === 'stub-row')?.kept).toBe(true);
  });

  it('produit une adresse technique non routable et unique par identifiant', () => {
    expect(closedAccountEmail(42)).toBe('closed.42@invalid.local');
    expect(isClosedAccount({ closedAt: null })).toBe(false);
    expect(isClosedAccount({ closedAt: new Date() })).toBe(true);
  });
});

describe('anonymize planning contacts', () => {
  it('remplace nom et numéro du contact ciblé seulement', () => {
    const mine = { nom: 'Alice Test', numero: '0600000000', personId: 7 };
    const other = { nom: 'Bob Test', numero: '0600000001', personId: 8 };
    expect(anonymizeAssignmentContact(mine, 7)).toBe(true);
    expect(mine).toMatchObject({ nom: ANONYMIZED_DISPLAY_NAME, numero: '' });
    expect(anonymizeAssignmentContact(other, 7)).toBe(false);
    expect(other.nom).toBe('Bob Test');
  });

  it('anonymise brouillon, extras et encadrants d’un snapshot', () => {
    const snapshot = {
      eventId: 'e1',
      eventType: 'entrainement',
      title: 'Entraînement',
      date: '01/01/2027',
      time: '10:00',
      durationMinutes: 90,
      location: null,
      planningStatus: 'draft',
      event: { encadrants: [{ nom: 'Alice Test', numero: '06', personId: 7 }] },
      extras: {
        id: 'e1',
        contactEncadrants: [{ nom: 'Alice Test', numero: '06', personId: 7 }],
        arbitreTouche: [{ nom: 'Bob Test', numero: '', personId: 8 }],
      },
      assignments: {
        arbitre: [],
        encadrant: [{ nom: 'Alice Test', numero: '06', personId: 7 }],
        accompagnateur: [],
      },
    } as unknown as PlanningEventSnapshot;
    expect(anonymizePlanningSnapshot(snapshot, 7)).toBe(true);
    expect(snapshot.assignments.encadrant[0]?.nom).toBe(ANONYMIZED_DISPLAY_NAME);
    expect(snapshot.extras?.contactEncadrants?.[0]?.nom).toBe(ANONYMIZED_DISPLAY_NAME);
    expect(snapshot.extras?.arbitreTouche?.[0]?.nom).toBe('Bob Test');
  });

  it('anonymise l’auteur d’un commentaire et supprime les préférences', () => {
    const comment = anonymizeOperationalPayload(
      'comment',
      { text: 'ok', authorUserId: 7, authorName: 'Alice Test', createdAt: '2026-01-01' },
      7,
    );
    expect(comment.changed).toBe(true);
    expect((comment.payload as { authorName: string }).authorName).toBe(ANONYMIZED_DISPLAY_NAME);

    const prefs = anonymizeOperationalPayload('notification-preferences', { push: true }, 7);
    expect(prefs.deleteRecord).toBe(true);
  });
});
