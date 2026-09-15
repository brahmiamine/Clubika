import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { hashSessionToken } from '@/lib/auth/session-token';

const PLAINTEXT_TOKEN = /^[a-f0-9]{64}$/;

async function tableExists(db: DataSource, table: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table],
  ) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

async function columnExists(db: DataSource, table: string, column: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1`,
    [table, column],
  ) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

async function hashPlaintextSessionRows(db: DataSource, table: string): Promise<number> {
  if (!(await tableExists(db, table)) || !(await columnExists(db, table, 'tokenHash'))) {
    return 0;
  }

  const rows = await db.query(`SELECT id FROM \`${table}\``) as Array<{ id: string }>;
  let migrated = 0;
  for (const row of rows) {
    if (!PLAINTEXT_TOKEN.test(row.id)) continue;
    const tokenHash = hashSessionToken(row.id);
    const nextId = randomUUID();
    await db.query(
      `UPDATE \`${table}\` SET id = ?, tokenHash = ? WHERE id = ?`,
      [nextId, tokenHash, row.id],
    );
    migrated += 1;
  }
  return migrated;
}

/**
 * Migration 0032 (issue #29) : les jetons de session club et plateforme ne sont
 * plus la clé primaire en clair. Les lignes dont `id` est encore un jeton 64 hex
 * sont réécrites : nouvel UUID interne + HMAC versionné, le cookie historique
 * reste valide. Les lignes sans jeton récupérable sont supprimées (révocation
 * contrôlée, pas de lecture dual-format permanente).
 */
export async function hashExistingSessionTokens(db: DataSource): Promise<{ club: number; platform: number }> {
  const club = await hashPlaintextSessionRows(db, 'user_sessions');
  const platform = await hashPlaintextSessionRows(db, 'platform_sessions');
  return { club, platform };
}

export async function finalizeHashedSessionSchema(db: DataSource): Promise<void> {
  for (const table of ['user_sessions', 'platform_sessions'] as const) {
    if (!(await tableExists(db, table)) || !(await columnExists(db, table, 'tokenHash'))) continue;

    await db.query(`DELETE FROM \`${table}\` WHERE tokenHash IS NULL OR tokenHash = ''`);
    await db.query(`UPDATE \`${table}\` SET lastSeenAt = createdAt WHERE lastSeenAt IS NULL`);
    await db.query(`ALTER TABLE \`${table}\` MODIFY tokenHash VARCHAR(96) NOT NULL`);
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_${table}_token_hash ON \`${table}\` (tokenHash)`,
    );
  }

  if (await tableExists(db, 'user_sessions')) {
    if (await columnExists(db, 'user_sessions', 'userAgent')) {
      await db.query('ALTER TABLE user_sessions DROP COLUMN IF EXISTS userAgent');
    }
    if (await columnExists(db, 'user_sessions', 'ipAddress')) {
      await db.query('ALTER TABLE user_sessions DROP COLUMN IF EXISTS ipAddress');
    }
  }
}
