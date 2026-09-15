import type { SessionUser } from '@/lib/auth/session';
import { isPlanningAdmin } from '@/lib/planning/event-access';
import type { PlanningRecord } from '@/lib/planning/records';

export const REPORT_CATEGORIES = ['organisation', 'incident', 'sportif', 'other'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_KIND = 'post-event-report' as const;

/** Notification copy: never include author, category, event title, or report body. */
export const REPORT_AVAILABLE_NOTICE = 'Un rapport est disponible';

export interface ReportPayload {
  category: ReportCategory;
  text: string;
  authorUserId: number;
  authorName: string;
  authorRole: string;
  createdAt: string;
}

/** Field-by-field public DTO — never a spread of the stored payload. */
export interface VisibleReport {
  id: string;
  category: ReportCategory;
  createdAt: string;
  text: string;
  canUpdate: boolean;
  canDelete: boolean;
}

export type ReportAction = 'create' | 'read' | 'update' | 'delete' | 'export';

/**
 * Access matrix (issue #28). Assignment to the event is not enough to read
 * someone else's report. Export of report bodies is forbidden.
 *
 * | Action | Auteur | Admin du tenant | Affecté non-auteur | Autre tenant |
 * | create | after event start if assigned, or admin | yes | if assigned after start | no |
 * | read   | own only | all in tenant | no | no |
 * | update | own only | no | no | no |
 * | delete | own | own tenant | no | no |
 * | export | never (body) | never (body) | never | never |
 */
export const REPORT_ACCESS_MATRIX: Record<ReportAction, string> = {
  create: 'Assigned after event start, or club admin of the same tenant.',
  read: 'Author of that report, or club admin of the same tenant.',
  update: 'Author only.',
  delete: 'Author, or club admin of the same tenant.',
  export: 'Report body is never exported, audited, logged, or placed in the outbox.',
};

export function isReportCategory(value: unknown): value is ReportCategory {
  return value === 'organisation' || value === 'incident' || value === 'sportif' || value === 'other';
}

export function isReportAuthor(user: SessionUser, record: PlanningRecord<ReportPayload>): boolean {
  return record.ownerUserId === user.id || record.payload.authorUserId === user.id;
}

export function canReadReport(user: SessionUser, record: PlanningRecord<ReportPayload>): boolean {
  if (record.clubId && record.clubId !== user.clubId) return false;
  if (record.kind !== REPORT_KIND) return false;
  return isPlanningAdmin(user) || isReportAuthor(user, record);
}

export function canUpdateReport(user: SessionUser, record: PlanningRecord<ReportPayload>): boolean {
  if (record.clubId && record.clubId !== user.clubId) return false;
  return isReportAuthor(user, record);
}

export function canDeleteReport(user: SessionUser, record: PlanningRecord<ReportPayload>): boolean {
  if (record.clubId && record.clubId !== user.clubId) return false;
  return isPlanningAdmin(user) || isReportAuthor(user, record);
}

export function toVisibleReport(user: SessionUser, record: PlanningRecord<ReportPayload>): VisibleReport {
  return {
    id: record.id,
    category: record.payload.category,
    createdAt: record.payload.createdAt,
    text: record.payload.text,
    canUpdate: canUpdateReport(user, record),
    canDelete: canDeleteReport(user, record),
  };
}

export function filterVisibleReports(
  user: SessionUser,
  records: PlanningRecord<ReportPayload>[],
): VisibleReport[] {
  return records.filter((record) => canReadReport(user, record)).map((record) => toVisibleReport(user, record));
}

/** Audit/outbox metadata — never the free-text body. */
export function reportAuditMeta(reportId: string): { reportId: string } {
  return { reportId };
}

export function parseReportPage(searchParams: URLSearchParams): { limit: number; offset: number } {
  const rawLimit = Number(searchParams.get('limit') ?? 20);
  const rawOffset = Number(searchParams.get('offset') ?? 0);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 20;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  return { limit, offset };
}

export function paginateReports(
  reports: VisibleReport[],
  limit: number,
  offset: number,
): { reports: VisibleReport[]; total: number; limit: number; offset: number } {
  return {
    reports: reports.slice(offset, offset + limit),
    total: reports.length,
    limit,
    offset,
  };
}
