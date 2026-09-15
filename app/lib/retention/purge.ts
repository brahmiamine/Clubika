import type { DataSource } from 'typeorm';
import { logError } from '@/lib/observability/log';
import {
  RETENTION_CATEGORIES,
  retentionBatchSize,
  retentionCutoff,
  retentionDaysFor,
  type RetentionCategoryId,
} from './policy';

export interface CategoryPurgeResult {
  category: RetentionCategoryId;
  days: number;
  scanned: number;
  deleted: number;
  dryRun: boolean;
  error?: string;
}

export interface RetentionPurgeReport {
  dryRun: boolean;
  batchSize: number;
  startedAt: string;
  finishedAt: string;
  success: boolean;
  categories: CategoryPurgeResult[];
  failedCategories: RetentionCategoryId[];
}

const MAX_ROUNDS = 50;

async function tableExists(db: DataSource, tableName: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [tableName],
  ) as unknown[];
  return rows.length > 0;
}

async function countQuery(db: DataSource, sql: string, params: unknown[]): Promise<number> {
  const rows = await db.query(sql, params) as Array<{ n?: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

async function deleteBatches(
  db: DataSource,
  deleteSql: string,
  params: unknown[],
  batchSize: number,
): Promise<number> {
  let deleted = 0;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await db.query(deleteSql, [...params, batchSize]) as { affectedRows?: number } | Array<{ affectedRows?: number }>;
    const head = Array.isArray(result) ? result[0] : result;
    const n = Number(head?.affectedRows ?? 0);
    deleted += n;
    if (n < batchSize) break;
  }
  return deleted;
}

async function purgeByCountAndDelete(
  db: DataSource,
  options: {
    dryRun: boolean;
    batchSize: number;
    countSql: string;
    countParams: unknown[];
    deleteSql: string;
    deleteParams: unknown[];
  },
): Promise<{ scanned: number; deleted: number }> {
  const scanned = await countQuery(db, options.countSql, options.countParams);
  if (options.dryRun || scanned === 0) return { scanned, deleted: 0 };
  const deleted = await deleteBatches(db, options.deleteSql, options.deleteParams, options.batchSize);
  return { scanned, deleted };
}

async function purgeChat(db: DataSource, clubId: string, cutoff: Date, dryRun: boolean, batchSize: number) {
  const attachmentCount = await tableExists(db, 'chat_attachments')
    ? await countQuery(
      db,
      'SELECT COUNT(*) AS n FROM chat_attachments WHERE club_id = ? AND created_at < ?',
      [clubId, cutoff],
    )
    : 0;
  const messageCount = await tableExists(db, 'chat_messages')
    ? await countQuery(
      db,
      `SELECT COUNT(*) AS n FROM chat_messages m
        INNER JOIN chat_rooms r ON r.id = m.roomId
       WHERE r.clubId = ? AND m.createdAt < ?`,
      [clubId, cutoff],
    )
    : 0;
  const scanned = attachmentCount + messageCount;
  if (dryRun || scanned === 0) return { scanned, deleted: 0 };

  let deleted = 0;
  if (await tableExists(db, 'chat_attachments')) {
    deleted += await deleteBatches(
      db,
      'DELETE FROM chat_attachments WHERE club_id = ? AND created_at < ? LIMIT ?',
      [clubId, cutoff],
      batchSize,
    );
  }
  if (await tableExists(db, 'chat_messages')) {
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const rows = await db.query(
        `SELECT m.id AS id, m.attachmentUrl AS attachmentUrl
           FROM chat_messages m
           INNER JOIN chat_rooms r ON r.id = m.roomId
          WHERE r.clubId = ? AND m.createdAt < ?
          ORDER BY m.createdAt ASC
          LIMIT ?`,
        [clubId, cutoff, batchSize],
      ) as Array<{ id: string; attachmentUrl: string | null }>;
      if (rows.length === 0) break;
      const ids = rows.map((row) => row.id);
      const attachmentIds = rows
        .map((row) => row.attachmentUrl?.split('/').pop())
        .filter((id): id is string => Boolean(id));
      if (attachmentIds.length && await tableExists(db, 'chat_attachments')) {
        await db.query(
          `DELETE FROM chat_attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})`,
          attachmentIds,
        );
      }
      if (await tableExists(db, 'chat_message_reactions')) {
        await db.query(
          `DELETE FROM chat_message_reactions WHERE messageId IN (${ids.map(() => '?').join(',')})`,
          ids,
        );
      }
      const result = await db.query(
        `DELETE FROM chat_messages WHERE id IN (${ids.map(() => '?').join(',')})`,
        ids,
      ) as { affectedRows?: number };
      deleted += Number(result.affectedRows ?? ids.length);
      if (rows.length < batchSize) break;
    }
  }
  return { scanned, deleted };
}

type ClubRunner = (
  db: DataSource,
  clubId: string,
  cutoff: Date,
  dryRun: boolean,
  batchSize: number,
) => Promise<{ scanned: number; deleted: number }>;

const clubRunners: Record<Exclude<RetentionCategoryId, 'rateLimits'>, ClubRunner> = {
  chat: purgeChat,
  async planningAttachments(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'planning_attachments')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: 'SELECT COUNT(*) AS n FROM planning_attachments WHERE club_id = ? AND created_at < ?',
      countParams: [clubId, cutoff],
      deleteSql: 'DELETE FROM planning_attachments WHERE club_id = ? AND created_at < ? LIMIT ?',
      deleteParams: [clubId, cutoff],
    });
  },
  async reports(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'planning_records')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: "SELECT COUNT(*) AS n FROM planning_records WHERE club_id = ? AND kind = 'post-event-report' AND created_at < ?",
      countParams: [clubId, cutoff],
      deleteSql: "DELETE FROM planning_records WHERE club_id = ? AND kind = 'post-event-report' AND created_at < ? LIMIT ?",
      deleteParams: [clubId, cutoff],
    });
  },
  async audit(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'match_audit_log')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: 'SELECT COUNT(*) AS n FROM match_audit_log WHERE clubId = ? AND createdAt < ?',
      countParams: [clubId, cutoff],
      deleteSql: 'DELETE FROM match_audit_log WHERE clubId = ? AND createdAt < ? LIMIT ?',
      deleteParams: [clubId, cutoff],
    });
  },
  async sessions(db, clubId, cutoff, dryRun, batchSize) {
    let scanned = 0;
    let deleted = 0;
    if (await tableExists(db, 'user_sessions')) {
      const part = await purgeByCountAndDelete(db, {
        dryRun,
        batchSize,
        countSql: `SELECT COUNT(*) AS n FROM user_sessions s
          INNER JOIN users u ON u.id = s.userId
         WHERE u.clubId = ?
           AND ((s.revokedAt IS NOT NULL AND s.revokedAt < ?) OR (s.expiresAt < ?))`,
        countParams: [clubId, cutoff, cutoff],
        deleteSql: `DELETE s FROM user_sessions s
          INNER JOIN users u ON u.id = s.userId
         WHERE u.clubId = ?
           AND ((s.revokedAt IS NOT NULL AND s.revokedAt < ?) OR (s.expiresAt < ?))
         LIMIT ?`,
        deleteParams: [clubId, cutoff, cutoff],
      });
      scanned += part.scanned;
      deleted += part.deleted;
    }
    return { scanned, deleted };
  },
  async notifications(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'notifications')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: `SELECT COUNT(*) AS n FROM notifications n
        INNER JOIN users u ON u.id = n.userId
       WHERE u.clubId = ? AND n.createdAt < ?`,
      countParams: [clubId, cutoff],
      deleteSql: `DELETE n FROM notifications n
        INNER JOIN users u ON u.id = n.userId
       WHERE u.clubId = ? AND n.createdAt < ?
       LIMIT ?`,
      deleteParams: [clubId, cutoff],
    });
  },
  async invitations(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'invitations')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: `SELECT COUNT(*) AS n FROM invitations
       WHERE clubId = ?
         AND ((usedAt IS NOT NULL AND usedAt < ?) OR (usedAt IS NULL AND expiresAt < ?))`,
      countParams: [clubId, cutoff, cutoff],
      deleteSql: `DELETE FROM invitations
       WHERE clubId = ?
         AND ((usedAt IS NOT NULL AND usedAt < ?) OR (usedAt IS NULL AND expiresAt < ?))
       LIMIT ?`,
      deleteParams: [clubId, cutoff, cutoff],
    });
  },
  async passwordReset(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'password_reset_tokens')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: `SELECT COUNT(*) AS n FROM password_reset_tokens t
        INNER JOIN users u ON u.id = t.userId
       WHERE u.clubId = ?
         AND ((t.usedAt IS NOT NULL AND t.usedAt < ?) OR t.expiresAt < ?)`,
      countParams: [clubId, cutoff, cutoff],
      deleteSql: `DELETE t FROM password_reset_tokens t
        INNER JOIN users u ON u.id = t.userId
       WHERE u.clubId = ?
         AND ((t.usedAt IS NOT NULL AND t.usedAt < ?) OR t.expiresAt < ?)
       LIMIT ?`,
      deleteParams: [clubId, cutoff, cutoff],
    });
  },
  async push(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'push_subscriptions')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: `SELECT COUNT(*) AS n FROM push_subscriptions p
        INNER JOIN users u ON u.id = p.user_id
       WHERE u.clubId = ? AND p.updated_at < ?`,
      countParams: [clubId, cutoff],
      deleteSql: `DELETE p FROM push_subscriptions p
        INNER JOIN users u ON u.id = p.user_id
       WHERE u.clubId = ? AND p.updated_at < ?
       LIMIT ?`,
      deleteParams: [clubId, cutoff],
    });
  },
  async scraperRuns(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'scraper_sync_runs')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: 'SELECT COUNT(*) AS n FROM scraper_sync_runs WHERE club_id = ? AND started_at < ?',
      countParams: [clubId, cutoff],
      deleteSql: 'DELETE FROM scraper_sync_runs WHERE club_id = ? AND started_at < ? LIMIT ?',
      deleteParams: [clubId, cutoff],
    });
  },
  async outbox(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'planning_notification_outbox')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: `SELECT COUNT(*) AS n FROM planning_notification_outbox o
        INNER JOIN users u ON u.id = o.user_id
       WHERE u.clubId = ? AND o.created_at < ?`,
      countParams: [clubId, cutoff],
      deleteSql: `DELETE o FROM planning_notification_outbox o
        INNER JOIN users u ON u.id = o.user_id
       WHERE u.clubId = ? AND o.created_at < ?
       LIMIT ?`,
      deleteParams: [clubId, cutoff],
    });
  },
  async publicShares(db, clubId, cutoff, dryRun, batchSize) {
    if (!await tableExists(db, 'planning_records')) return { scanned: 0, deleted: 0 };
    return purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: "SELECT COUNT(*) AS n FROM planning_records WHERE club_id = ? AND kind = 'public-share' AND created_at < ?",
      countParams: [clubId, cutoff],
      deleteSql: "DELETE FROM planning_records WHERE club_id = ? AND kind = 'public-share' AND created_at < ? LIMIT ?",
      deleteParams: [clubId, cutoff],
    });
  },
};

async function purgePlatformSessions(db: DataSource, cutoff: Date, dryRun: boolean, batchSize: number) {
  if (!await tableExists(db, 'platform_sessions')) return { scanned: 0, deleted: 0 };
  return purgeByCountAndDelete(db, {
    dryRun,
    batchSize,
    countSql: `SELECT COUNT(*) AS n FROM platform_sessions
     WHERE (revokedAt IS NOT NULL AND revokedAt < ?) OR expiresAt < ?`,
    countParams: [cutoff, cutoff],
    deleteSql: `DELETE FROM platform_sessions
     WHERE ((revokedAt IS NOT NULL AND revokedAt < ?) OR expiresAt < ?)
     LIMIT ?`,
    deleteParams: [cutoff, cutoff],
  });
}

async function purgeRateLimits(db: DataSource, cutoff: Date, dryRun: boolean, batchSize: number) {
  let scanned = 0;
  let deleted = 0;
  if (await tableExists(db, 'login_rate_limits')) {
    const part = await purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: 'SELECT COUNT(*) AS n FROM login_rate_limits WHERE last_attempt_at < ?',
      countParams: [cutoff],
      deleteSql: 'DELETE FROM login_rate_limits WHERE last_attempt_at < ? LIMIT ?',
      deleteParams: [cutoff],
    });
    scanned += part.scanned;
    deleted += part.deleted;
  }
  if (await tableExists(db, 'chat_rate_limit_events')) {
    const part = await purgeByCountAndDelete(db, {
      dryRun,
      batchSize,
      countSql: 'SELECT COUNT(*) AS n FROM chat_rate_limit_events WHERE created_at < ?',
      countParams: [cutoff],
      deleteSql: 'DELETE FROM chat_rate_limit_events WHERE created_at < ? LIMIT ?',
      deleteParams: [cutoff],
    });
    scanned += part.scanned;
    deleted += part.deleted;
  }
  return { scanned, deleted };
}

async function recordPurgeRun(db: DataSource, report: RetentionPurgeReport): Promise<void> {
  if (!await tableExists(db, 'retention_purge_runs')) return;
  await db.query(
    `INSERT INTO retention_purge_runs (dry_run, success, started_at, finished_at, summary)
     VALUES (?, ?, ?, ?, ?)`,
    [
      report.dryRun ? 1 : 0,
      report.success ? 1 : 0,
      report.startedAt.slice(0, 19).replace('T', ' '),
      report.finishedAt.slice(0, 19).replace('T', ' '),
      JSON.stringify({
        failedCategories: report.failedCategories,
        categories: report.categories.map((item) => ({
          category: item.category,
          scanned: item.scanned,
          deleted: item.deleted,
          error: item.error ?? null,
        })),
      }),
    ],
  );
}

export async function runRetentionPurge(
  db: DataSource,
  options: { dryRun: boolean; clubIds: string[]; now?: Date },
): Promise<RetentionPurgeReport> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const batchSize = retentionBatchSize();
  const totals = new Map<RetentionCategoryId, CategoryPurgeResult>();

  const add = (next: CategoryPurgeResult) => {
    const prev = totals.get(next.category);
    if (!prev) {
      totals.set(next.category, next);
      return;
    }
    totals.set(next.category, {
      ...next,
      scanned: prev.scanned + next.scanned,
      deleted: prev.deleted + next.deleted,
      error: prev.error ?? next.error,
    });
  };

  for (const category of RETENTION_CATEGORIES) {
    const days = retentionDaysFor(category);
    const cutoff = retentionCutoff(days, now);
    if (category.scope === 'global') {
      try {
        const result = category.id === 'rateLimits'
          ? await purgeRateLimits(db, cutoff, options.dryRun, batchSize)
          : { scanned: 0, deleted: 0 };
        add({ category: category.id, days, dryRun: options.dryRun, ...result });
      } catch (error) {
        add({
          category: category.id,
          days,
          dryRun: options.dryRun,
          scanned: 0,
          deleted: 0,
          error: 'category_failed',
        });
        logError('app.unhandled', '[retention-purge] category failed', category.id, error instanceof Error ? error.name : 'error');
      }
      continue;
    }

    const runner = clubRunners[category.id as Exclude<RetentionCategoryId, 'rateLimits'>];
    for (const clubId of options.clubIds) {
      try {
        const result = await runner(db, clubId, cutoff, options.dryRun, batchSize);
        add({ category: category.id, days, dryRun: options.dryRun, ...result });
      } catch (error) {
        add({
          category: category.id,
          days,
          dryRun: options.dryRun,
          scanned: 0,
          deleted: 0,
          error: 'category_failed',
        });
        logError('app.unhandled', '[retention-purge] category failed', category.id, error instanceof Error ? error.name : 'error');
      }
    }
    if (category.id === 'sessions') {
      try {
        const result = await purgePlatformSessions(db, cutoff, options.dryRun, batchSize);
        add({ category: category.id, days, dryRun: options.dryRun, ...result });
      } catch (error) {
        add({
          category: category.id,
          days,
          dryRun: options.dryRun,
          scanned: 0,
          deleted: 0,
          error: 'category_failed',
        });
        logError('app.unhandled', '[retention-purge] category failed', category.id, error instanceof Error ? error.name : 'error');
      }
    }
  }

  const categories = RETENTION_CATEGORIES.map((category) => totals.get(category.id) ?? {
    category: category.id,
    days: retentionDaysFor(category),
    scanned: 0,
    deleted: 0,
    dryRun: options.dryRun,
  });
  const failedCategories = categories.filter((item) => item.error).map((item) => item.category);
  const report: RetentionPurgeReport = {
    dryRun: options.dryRun,
    batchSize,
    startedAt,
    finishedAt: new Date().toISOString(),
    success: failedCategories.length === 0,
    categories,
    failedCategories,
  };
  try {
    await recordPurgeRun(db, report);
  } catch (error) {
    logError('app.unhandled', '[retention-purge] run journal failed', error instanceof Error ? error.name : 'error');
  }
  return report;
}
