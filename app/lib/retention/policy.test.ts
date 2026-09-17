import { describe, expect, it } from 'vitest';
import {
  RETENTION_CATEGORIES,
  parsePositiveInt,
  resolvedRetentionPolicy,
  retentionCutoff,
  retentionDaysFor,
} from './policy';

describe('retention policy (issue #9)', () => {
  it('documents a product default for every category without claiming a legal basis', () => {
    expect(RETENTION_CATEGORIES.length).toBeGreaterThanOrEqual(10);
    const ids = RETENTION_CATEGORIES.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'chat',
      'planningAttachments',
      'reports',
      'audit',
      'sessions',
      'notifications',
      'invitations',
      'push',
      'scraperRuns',
      'publicShares',
    ]));
    for (const category of RETENTION_CATEGORIES) {
      expect(category.defaultDays).toBeGreaterThan(0);
      expect(category.purpose.length).toBeGreaterThan(10);
      expect(category.envKey.startsWith('RETENTION_')).toBe(true);
    }
  });

  it('purge les liens de partage expirés peu après leur échéance, séparément du filet de sécurité sur la création (issue #14)', () => {
    const expired = RETENTION_CATEGORIES.find((item) => item.id === 'publicSharesExpired');
    const safetyNet = RETENTION_CATEGORIES.find((item) => item.id === 'publicShares');
    if (!expired || !safetyNet) throw new Error('publicSharesExpired/publicShares category missing');
    expect(expired.defaultDays).toBe(7);
    expect(expired.envKey).toBe('RETENTION_PUBLIC_SHARES_EXPIRED_DAYS');
    expect(expired.defaultDays).toBeLessThan(safetyNet.defaultDays);
  });

  it('reads env overrides and rejects non-positive values', () => {
    const chat = RETENTION_CATEGORIES.find((item) => item.id === 'chat');
    if (!chat) throw new Error('chat category missing');
    expect(retentionDaysFor(chat, { RETENTION_CHAT_DAYS: '90' })).toBe(90);
    expect(retentionDaysFor(chat, { RETENTION_CHAT_DAYS: '0' })).toBe(chat.defaultDays);
    expect(parsePositiveInt('nope', 12)).toBe(12);
    expect(resolvedRetentionPolicy({ RETENTION_AUDIT_DAYS: '180' }).find((item) => item.id === 'audit')?.days).toBe(180);
  });

  it('computes a cutoff in the past', () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    expect(retentionCutoff(365, now).toISOString()).toBe('2025-09-15T00:00:00.000Z');
  });
});
