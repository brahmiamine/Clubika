import type { DataSource } from 'typeorm';
import {
  isHealthCommentPurgeEnabled,
  sanitizeAssignmentStateRecord,
  sanitizeIndisponibilitesForHealthData,
} from '@/lib/privacy/health-data';
import { normalizeIndisponibilites } from '@/lib/utils/officiel-availability';

export interface HealthDataMigrationReport {
  dryRun: boolean;
  assignmentRowsScanned: number;
  assignmentInjuryRemapped: number;
  assignmentCommentsPresent: number;
  assignmentCommentsPurged: number;
  reviewCommentsPresent: number;
  reviewCommentsPurged: number;
  usersScanned: number;
}

function emptyReport(dryRun: boolean): HealthDataMigrationReport {
  return {
    dryRun,
    assignmentRowsScanned: 0,
    assignmentInjuryRemapped: 0,
    assignmentCommentsPresent: 0,
    assignmentCommentsPurged: 0,
    reviewCommentsPresent: 0,
    reviewCommentsPurged: 0,
    usersScanned: 0,
  };
}

async function tableExists(db: DataSource, tableName: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [tableName],
  ) as unknown[];
  return rows.length > 0;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Migration 0026 (issue #7).
 *
 * Toujours appliqué : `declineReason = injury` → `personal`.
 * Commentaires libres (`declineComment`, `reviewComment`) : comptés, jamais classifiés.
 * Purge uniquement si `HEALTH_COMMENT_PURGE=apply` (revue humaine des volumes).
 */
export async function migrateHealthDataFields(
  db: DataSource,
  options: { purgeComments?: boolean } = {},
): Promise<HealthDataMigrationReport> {
  const purgeComments = options.purgeComments ?? isHealthCommentPurgeEnabled();
  const report = emptyReport(!purgeComments);

  if (await tableExists(db, 'planning_assignment_state')) {
    const rows = await db.query(
      'SELECT club_id AS clubId, event_type AS eventType, event_id AS eventId, role, person_key AS personKey, state FROM planning_assignment_state',
    ) as Array<Record<string, unknown>>;
    report.assignmentRowsScanned = rows.length;

    for (const row of rows) {
      const state = parseJsonObject(row.state);
      if (!state) continue;
      const result = sanitizeAssignmentStateRecord(state, { purgeComments });
      if (result.injuryRemapped) report.assignmentInjuryRemapped += 1;
      if (result.commentPresent) report.assignmentCommentsPresent += 1;
      if (result.commentPurged) report.assignmentCommentsPurged += 1;
      if (!result.changed) continue;
      await db.query(
        `UPDATE planning_assignment_state SET state = ?, updated_at = CURRENT_TIMESTAMP(6)
         WHERE club_id = ? AND event_type = ? AND event_id = ? AND role = ? AND person_key = ?`,
        [
          JSON.stringify(result.next),
          row.clubId,
          row.eventType,
          row.eventId,
          row.role,
          row.personKey,
        ],
      );
    }
  }

  if (await tableExists(db, 'users')) {
    const users = await db.query(
      'SELECT id, indisponibilites FROM users',
    ) as Array<{ id: number; indisponibilites: unknown }>;
    report.usersScanned = users.length;

    for (const user of users) {
      const items = normalizeIndisponibilites(user.indisponibilites);
      if (items.length === 0) continue;
      const result = sanitizeIndisponibilitesForHealthData(items, { purgeComments });
      report.reviewCommentsPresent += result.commentsPresent;
      report.reviewCommentsPurged += result.commentsPurged;
      if (!result.changed) continue;
      await db.query('UPDATE users SET indisponibilites = ? WHERE id = ?', [
        JSON.stringify(result.next),
        user.id,
      ]);
    }
  }

  console.info(
    '[migrations] 0026 health-data:',
    `injuryRemapped=${report.assignmentInjuryRemapped}`,
    `declineComments=${report.assignmentCommentsPresent}`,
    `reviewComments=${report.reviewCommentsPresent}`,
    purgeComments
      ? `purged comments (decline=${report.assignmentCommentsPurged}, review=${report.reviewCommentsPurged})`
      : 'dry-run for comments (set HEALTH_COMMENT_PURGE=apply to unset free-text fields)',
  );

  return report;
}
