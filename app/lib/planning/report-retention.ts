import type { DataSource, EntityManager } from 'typeorm';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  deletePlanningRecord,
  listPlanningRecords,
} from '@/lib/planning/records';
import {
  isPastReportRetention,
  isPostEventReportCategory,
  reportAuditAfter,
  reportDeletionAuditAfter,
  type PostEventReportCategory,
} from '@/lib/planning/report-privacy';

type Queryable = DataSource | EntityManager;

/**
 * Purge les rapports post-événement plus anciens que la durée opérationnelle
 * (issue #8). Trace d’audit minimale, sans le texte. Politique globale : #9.
 */
export async function purgeExpiredPostEventReports(db: Queryable, now = new Date()): Promise<number> {
  const records = await listPlanningRecords<{ category?: unknown }>(db, { kind: 'post-event-report' }, 1000);
  let purged = 0;
  for (const record of records) {
    if (!isPastReportRetention(record.createdAt, now)) continue;
    const category: PostEventReportCategory = isPostEventReportCategory(record.payload.category)
      ? record.payload.category
      : 'other';
    await deletePlanningRecord(db, record.id);
    await logAuditEntry(db, {
      user: null,
      clubId: record.clubId,
      entityType: 'PlanningCollaboration',
      entityId: record.id,
      action: 'delete',
      before: reportAuditAfter({
        reportId: record.id,
        eventType: record.eventType ?? '',
        eventId: record.eventId ?? '',
        category,
      }),
      after: reportDeletionAuditAfter('retention'),
    });
    purged += 1;
  }
  return purged;
}
