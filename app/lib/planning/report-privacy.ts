export const DEFAULT_POST_EVENT_REPORT_RETENTION_DAYS = 365;

const SENSITIVE_REPORT_KEYS = [
  'text',
  'authorName',
  'authorUserId',
  'authorRole',
  'authorEmail',
] as const;

export type PostEventReportCategory = 'incident' | 'organisation' | 'sportif' | 'other';

export function isPostEventReportCategory(value: unknown): value is PostEventReportCategory {
  return value === 'incident' || value === 'organisation' || value === 'sportif' || value === 'other';
}

export interface ReportAuditMetadata {
  reportId: string;
  eventType: string;
  eventId: string;
  category: PostEventReportCategory;
}

/** Durée opérationnelle (jours). La base légale globale est issue #9 — ne pas l’inventer ici. */
export function postEventReportRetentionDays(): number {
  const raw = process.env.POST_EVENT_REPORT_RETENTION_DAYS;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_POST_EVENT_REPORT_RETENTION_DAYS;
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_POST_EVENT_REPORT_RETENTION_DAYS;
  return Math.min(parsed, 3650);
}

export function isPastReportRetention(createdAt: Date, now = new Date(), days = postEventReportRetentionDays()): boolean {
  return now.getTime() - createdAt.getTime() >= days * 24 * 60 * 60 * 1000;
}

/** Métadonnées d’audit pour l’action `report` — jamais le texte du rapport. */
export function reportAuditAfter(meta: ReportAuditMetadata): Record<string, unknown> {
  return {
    reportId: meta.reportId,
    eventType: meta.eventType,
    eventId: meta.eventId,
    category: meta.category,
  };
}

export function reportDeletionAuditAfter(reason: 'user' | 'retention'): Record<string, unknown> {
  return { deleted: true, reason };
}

export function containsReportBody(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return SENSITIVE_REPORT_KEYS.some((key) => {
    const candidate = record[key];
    return candidate !== undefined && candidate !== null && candidate !== '';
  });
}

export function needsReportAuditRedaction(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): boolean {
  return containsReportBody(before) || containsReportBody(after);
}

export function redactReportAuditPayload(
  value: Record<string, unknown> | null,
  extras: Record<string, unknown> = {},
): Record<string, unknown> | null {
  if (!value && Object.keys(extras).length === 0) return null;
  const next: Record<string, unknown> = {};
  const source = value ?? {};
  for (const key of ['reportId', 'eventType', 'eventId', 'category', 'createdAt'] as const) {
    const candidate = source[key];
    if (typeof candidate === 'string' && candidate.length > 0) next[key] = candidate;
  }
  return { ...next, ...extras };
}

export function serializedAuditOmitsReportBody(entry: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}): boolean {
  const blob = JSON.stringify(entry);
  if (containsReportBody(entry.before) || containsReportBody(entry.after)) return false;
  return !/"text"\s*:/.test(blob);
}
