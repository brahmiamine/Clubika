import type { DataSource } from 'typeorm';
import { logInfo } from '@/lib/observability/log';

/**
 * Purge des messages fournisseur bruts stockés dans `planning_notification_outbox.last_error`
 * (issue #31). Idempotente. `MIGRATION_DRY_RUN=1` compte sans écrire.
 */
export async function purgeOutboxLastError(db: DataSource): Promise<{ before: number; after: number }> {
  const table = await db.query(
    `SELECT COUNT(*) AS c FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'planning_notification_outbox'`,
  ) as Array<{ c: number | string }>;
  if (Number(table[0]?.c ?? 0) === 0) return { before: 0, after: 0 };

  const beforeRows = await db.query(
    `SELECT COUNT(*) AS c FROM planning_notification_outbox
     WHERE last_error IS NOT NULL AND last_error NOT LIKE '{"code":%'`,
  ) as Array<{ c: number | string }>;
  const before = Number(beforeRows[0]?.c ?? 0);

  if (process.env.MIGRATION_DRY_RUN === '1') {
    logInfo('outbox.last_error_purged', { dryRun: true, before, after: before });
    return { before, after: before };
  }

  if (before > 0) {
    await db.query(
      `UPDATE planning_notification_outbox
       SET last_error = NULL
       WHERE last_error IS NOT NULL AND last_error NOT LIKE '{"code":%'`,
    );
  }

  const afterRows = await db.query(
    `SELECT COUNT(*) AS c FROM planning_notification_outbox
     WHERE last_error IS NOT NULL AND last_error NOT LIKE '{"code":%'`,
  ) as Array<{ c: number | string }>;
  const after = Number(afterRows[0]?.c ?? 0);
  logInfo('outbox.last_error_purged', { dryRun: false, before, after });
  return { before, after };
}
