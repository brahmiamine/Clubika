import type { AssignmentContact, AssignmentStatus, DeclineReason } from '@/types/match';
import { isDeclineReason } from '@/lib/planning/advanced-rules';
import {
  indispoReviewCodeLabel,
  isIndispoReviewCode,
  type IndispoReviewCode,
} from '@/lib/indisponibilites/review';
import type { OfficielIndisponibilite } from '@/lib/utils/officiel-availability';
import {
  FORBIDDEN_DECLINE_REASONS,
  HEALTH_COMMENT_PURGE_ENV,
  NO_SENSITIVE_PERSONAL_DATA_WARNING,
} from '@/lib/privacy/sensitive-copy';

export {
  FORBIDDEN_DECLINE_REASONS,
  HEALTH_COMMENT_PURGE_ENV,
  NO_SENSITIVE_PERSONAL_DATA_WARNING,
};

export function isForbiddenDeclineReason(value: unknown): boolean {
  return typeof value === 'string' && (FORBIDDEN_DECLINE_REASONS as readonly string[]).includes(value);
}

/**
 * Ancienne valeur `injury` → motif générique `personal`.
 * Les autres valeurs hors liste sont ignorées (jamais réintroduites telles quelles).
 */
export function normalizeStoredDeclineReason(value: unknown): DeclineReason | undefined {
  if (value === 'injury') return 'personal';
  return isDeclineReason(value) ? value : undefined;
}

export function parseIncomingDeclineReason(value: unknown):
  | { ok: true; reason: DeclineReason | null }
  | { ok: false; error: string } {
  if (value === undefined || value === null || value === '') {
    return { ok: true, reason: null };
  }
  if (isForbiddenDeclineReason(value)) {
    return { ok: false, error: 'Les motifs médicaux ne sont pas acceptés.' };
  }
  if (!isDeclineReason(value)) {
    return { ok: false, error: 'Motif de refus invalide' };
  }
  return { ok: true, reason: value };
}

/** Contact persisté / lu : pas de commentaire libre, motif historique `injury` recalé. */
export function sanitizeAssignmentOperationalFields<T extends {
  declineReason?: DeclineReason | string;
  declineComment?: string | null;
}>(input: T): T {
  const { declineComment: _dropped, ...rest } = input;
  void _dropped;
  const declineReason = normalizeStoredDeclineReason(input.declineReason);
  return {
    ...rest,
    declineReason,
    declineComment: undefined,
  } as T;
}

export function redactAssignmentContactForAudit(contact: AssignmentContact): Record<string, unknown> {
  const sanitized = sanitizeAssignmentOperationalFields(contact);
  return {
    nom: sanitized.nom,
    personId: sanitized.personId ?? null,
    personType: sanitized.personType ?? null,
    status: sanitized.status ?? null,
    respondedAt: sanitized.respondedAt ?? null,
    declineReason: sanitized.declineReason ?? null,
  };
}

export function assignmentDeclineNotificationSuffix(status: AssignmentStatus, reason: DeclineReason | null): string {
  if (status !== 'declined' || !reason) return '';
  return ` Motif : ${reason}.`;
}

export function isHealthCommentPurgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[HEALTH_COMMENT_PURGE_ENV] === 'apply';
}

export interface AssignmentStateSanitization {
  next: Record<string, unknown>;
  changed: boolean;
  injuryRemapped: boolean;
  commentPresent: boolean;
  commentPurged: boolean;
}

export function sanitizeAssignmentStateRecord(
  state: Record<string, unknown>,
  options: { purgeComments: boolean },
): AssignmentStateSanitization {
  const next: Record<string, unknown> = { ...state };
  let changed = false;
  let injuryRemapped = false;
  const commentPresent = typeof next.declineComment === 'string' && next.declineComment.trim().length > 0;
  let commentPurged = false;

  if (next.declineReason === 'injury') {
    next.declineReason = 'personal';
    injuryRemapped = true;
    changed = true;
  }

  if (commentPresent && options.purgeComments) {
    delete next.declineComment;
    commentPurged = true;
    changed = true;
  }

  return { next, changed, injuryRemapped, commentPresent, commentPurged };
}

export interface IndispoSanitization {
  next: OfficielIndisponibilite[];
  changed: boolean;
  commentsPresent: number;
  commentsPurged: number;
}

/**
 * Ne classifie pas le texte. Compte (et éventuellement retire) les `reviewComment`
 * libres. Un code structuré déjà stocké dans `reviewCode` est conservé.
 */
export function sanitizeIndisponibilitesForHealthData(
  items: OfficielIndisponibilite[],
  options: { purgeComments: boolean },
): IndispoSanitization {
  const commentsPresent = items.filter(
    (item) => typeof item.reviewComment === 'string' && item.reviewComment.trim().length > 0,
  ).length;

  if (!options.purgeComments) {
    return { next: items, changed: false, commentsPresent, commentsPurged: 0 };
  }

  let commentsPurged = 0;
  const next = items.map((item) => {
    const hasFreeComment = typeof item.reviewComment === 'string' && item.reviewComment.trim().length > 0;
    if (!hasFreeComment) return item;

    const copy: OfficielIndisponibilite = { ...item };
    if (!copy.reviewCode && isIndispoReviewCode(item.reviewComment)) {
      copy.reviewCode = item.reviewComment;
    }
    delete copy.reviewComment;
    commentsPurged += 1;
    return copy;
  });

  return { next, changed: commentsPurged > 0, commentsPresent, commentsPurged };
}

export function publicIndispoReviewLabel(rule: Pick<OfficielIndisponibilite, 'reviewCode' | 'reviewComment'>): string | null {
  if (isIndispoReviewCode(rule.reviewCode)) {
    return indispoReviewCodeLabel(rule.reviewCode);
  }
  if (isIndispoReviewCode(rule.reviewComment)) {
    return indispoReviewCodeLabel(rule.reviewComment);
  }
  return null;
}

export type { IndispoReviewCode };
