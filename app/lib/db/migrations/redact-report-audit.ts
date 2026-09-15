import type { DataSource } from 'typeorm';
import {
  needsReportAuditRedaction,
  redactReportAuditPayload,
} from '@/lib/planning/report-privacy';

function parseJsonColumn(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
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
 * Migration 0025 (issue #8) — les anciennes lignes d’audit `action = report`
 * recopiaient le payload métier (texte, nom d’auteur). On les remplace par des
 * métadonnées minimales. Idempotent : une ligne déjà expurgée n’est pas retouchée.
 *
 * Dry-run : compte sans écrire. Ne journalise jamais le texte expurgé.
 */
export async function redactHistoricalReportAudits(
  db: DataSource,
  options: { dryRun?: boolean; tableName?: string; recordsTable?: string } = {},
): Promise<{ scanned: number; updated: number }> {
  const auditTable = options.tableName ?? 'match_audit_log';
  const recordsTable = options.recordsTable ?? 'planning_records';
  const dryRun = options.dryRun === true;

  const present = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [auditTable],
  ) as unknown[];
  if (present.length === 0) return { scanned: 0, updated: 0 };

  const rows = await db.query(
    `SELECT a.id AS id, a.entityId AS entityId, a.\`before\` AS beforeJson, a.\`after\` AS afterJson,
            r.event_type AS eventType, r.event_id AS eventId
       FROM \`${auditTable}\` a
       LEFT JOIN \`${recordsTable}\` r ON r.id = a.entityId
      WHERE a.action = 'report' AND a.entityType = 'PlanningCollaboration'`,
  ) as Array<{
    id: number;
    entityId: string;
    beforeJson: unknown;
    afterJson: unknown;
    eventType: string | null;
    eventId: string | null;
  }>;

  let updated = 0;
  for (const row of rows) {
    const before = parseJsonColumn(row.beforeJson);
    const after = parseJsonColumn(row.afterJson);
    if (!needsReportAuditRedaction(before, after)) continue;
    updated += 1;
    if (dryRun) continue;
    const extras = {
      reportId: row.entityId,
      redacted: true,
      ...(row.eventType ? { eventType: row.eventType } : {}),
      ...(row.eventId ? { eventId: row.eventId } : {}),
    };
    const nextBefore = redactReportAuditPayload(before);
    const nextAfter = redactReportAuditPayload(after, extras);
    await db.query(
      `UPDATE \`${auditTable}\` SET \`before\` = ?, \`after\` = ? WHERE id = ?`,
      [nextBefore ? JSON.stringify(nextBefore) : null, nextAfter ? JSON.stringify(nextAfter) : null, row.id],
    );
  }

  return { scanned: rows.length, updated };
}
