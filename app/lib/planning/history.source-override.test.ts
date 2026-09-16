import { describe, expect, it } from 'vitest';
import type { MatchAuditLogEntity } from '@/lib/db/schemas';
import { humanizeAuditEntry } from './history';

function entry(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): MatchAuditLogEntity {
  return {
    id: 1,
    clubId: 'afp',
    entityType: 'MatchOfficial',
    entityId: 'match-1',
    action: 'update',
    userId: 1,
    userEmail: 'admin@example.test',
    userNom: 'Admin',
    before,
    after,
    createdAt: new Date('2026-09-07T18:00:00.000Z'),
  };
}

describe('historique des overrides source (issue #151)', () => {
  it('rend lisibles les champs corrigés par un administrateur', () => {
    const item = humanizeAuditEntry(entry(
      { sourceOverride: { active: false, changedFields: [] } },
      { sourceOverride: { active: true, changedFields: ['date', 'time', 'details.stadium'] } },
    ));

    expect((item as unknown as { sourceOverrideSummary?: string }).sourceOverrideSummary)
      .toBe('Correction admin : Date, Heure, Stade');
    expect(item.actor).toBe('Utilisateur #1');
  });

  it('indique explicitement un retour aux données source', () => {
    const item = humanizeAuditEntry(entry(
      { sourceOverride: { active: true, changedFields: ['date'] } },
      { sourceOverride: { active: false, changedFields: [] } },
    ));

    expect((item as unknown as { sourceOverrideSummary?: string }).sourceOverrideSummary)
      .toBe('Retour aux données source');
  });
});
