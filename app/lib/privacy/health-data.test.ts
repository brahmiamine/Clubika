import { describe, expect, it } from 'vitest';
import { isDeclineReason } from '@/lib/planning/advanced-rules';
import {
  assignmentDeclineNotificationSuffix,
  isForbiddenDeclineReason,
  isHealthCommentPurgeEnabled,
  normalizeStoredDeclineReason,
  parseIncomingDeclineReason,
  publicIndispoReviewLabel,
  redactAssignmentContactForAudit,
  sanitizeAssignmentOperationalFields,
  sanitizeAssignmentStateRecord,
  sanitizeIndisponibilitesForHealthData,
} from './health-data';
import { NO_SENSITIVE_PERSONAL_DATA_WARNING } from './sensitive-copy';

describe('health-data (issue #7)', () => {
  it('refuse injury comme motif structuré, y compris à l’entrée API', () => {
    expect(isDeclineReason('injury')).toBe(false);
    expect(isForbiddenDeclineReason('injury')).toBe(true);
    expect(parseIncomingDeclineReason('injury')).toEqual({
      ok: false,
      error: 'Les motifs médicaux ne sont pas acceptés.',
    });
    expect(parseIncomingDeclineReason('personal')).toEqual({ ok: true, reason: 'personal' });
  });

  it('recalcule les motifs historiques injury vers personal sans conserver le commentaire', () => {
    expect(normalizeStoredDeclineReason('injury')).toBe('personal');
    expect(sanitizeAssignmentOperationalFields({
      nom: 'Personne',
      numero: '',
      declineReason: 'injury',
      declineComment: 'entorse',
    })).toMatchObject({
      nom: 'Personne',
      declineReason: 'personal',
      declineComment: undefined,
    });
  });

  it('expurge audit et notifications de tout commentaire de refus', () => {
    const audit = redactAssignmentContactForAudit({
      nom: 'Personne',
      numero: '0600000000',
      status: 'declined',
      declineReason: 'personal',
      declineComment: 'ne pas copier',
    });
    expect(JSON.stringify(audit)).not.toContain('ne pas copier');
    expect(audit).not.toHaveProperty('declineComment');
    expect(assignmentDeclineNotificationSuffix('declined', 'personal')).toBe(' Motif : personal.');
    expect(assignmentDeclineNotificationSuffix('declined', 'personal')).not.toContain('ne pas');
  });

  it('affiche l’avertissement CNIL attendu et masque les reviewComment libres', () => {
    expect(NO_SENSITIVE_PERSONAL_DATA_WARNING).toBe(
      'Ne renseignez aucune donnée médicale ou autre donnée sensible concernant une personne.',
    );
    expect(publicIndispoReviewLabel({ reviewComment: 'entorse au genou' })).toBeNull();
    expect(publicIndispoReviewLabel({ reviewComment: 'schedule_too_broad' })).toBeNull();
    expect(publicIndispoReviewLabel({ reviewCode: 'schedule_too_broad' })).toBe('Créneau trop large');
  });

  it('migre injury et compte les commentaires sans les classer ; purge seulement sur apply', () => {
    const dry = sanitizeAssignmentStateRecord(
      { status: 'declined', declineReason: 'injury', declineComment: 'texte libre' },
      { purgeComments: false },
    );
    expect(dry).toMatchObject({
      injuryRemapped: true,
      commentPresent: true,
      commentPurged: false,
      next: { declineReason: 'personal', declineComment: 'texte libre' },
    });

    const applied = sanitizeAssignmentStateRecord(dry.next, { purgeComments: true });
    expect(applied.commentPurged).toBe(true);
    expect(applied.next).not.toHaveProperty('declineComment');

    const indispoDry = sanitizeIndisponibilitesForHealthData(
      [{ id: 'r1', type: 'day-range', dateStart: '01/10/2026', dateEnd: '02/10/2026', reviewComment: 'texte historique' }],
      { purgeComments: false },
    );
    expect(indispoDry).toMatchObject({ changed: false, commentsPresent: 1, commentsPurged: 0 });
    expect(indispoDry.next[0]?.reviewComment).toBe('texte historique');

    const indispoApply = sanitizeIndisponibilitesForHealthData(indispoDry.next, { purgeComments: true });
    expect(indispoApply.commentsPurged).toBe(1);
    expect(indispoApply.next[0]?.reviewComment).toBeUndefined();

    const coincidentalCode = sanitizeIndisponibilitesForHealthData(
      [{ id: 'r2', type: 'day-range', dateStart: '01/10/2026', dateEnd: '02/10/2026', reviewComment: 'schedule_too_broad' }],
      { purgeComments: true },
    );
    expect(coincidentalCode.next[0]?.reviewComment).toBeUndefined();
    expect(coincidentalCode.next[0]?.reviewCode).toBeUndefined();
  });

  it('n’active la purge que si HEALTH_COMMENT_PURGE=apply', () => {
    expect(isHealthCommentPurgeEnabled({})).toBe(false);
    expect(isHealthCommentPurgeEnabled({ HEALTH_COMMENT_PURGE: 'true' })).toBe(false);
    expect(isHealthCommentPurgeEnabled({ HEALTH_COMMENT_PURGE: 'apply' })).toBe(true);
  });
});
