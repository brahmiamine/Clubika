import type { DataSource } from 'typeorm';

function defaultClubId(): string {
  return process.env.APP_CLUB_ID || 'afp';
}

/**
 * Migration 0009 (issue #126) — tenantisation de `match_audit_log`.
 *
 * La colonne `clubId` est ajoutée nullable (une colonne NOT NULL ne peut pas
 * être créée sur une table existante remplie), remplie par jointure sur
 * `users` (club de l'auteur de l'écriture) puis, pour les lignes orphelines
 * (utilisateur supprimé) ou système de l'ère mono-club, repli sur
 * APP_CLUB_ID avec signalisation. `synchronize` (exécuté après le runner,
 * cf. #125) durcit ensuite la colonne en NOT NULL et crée l'index tenant.
 */

export interface AuditLogTenantBackfillResult {
  joined: number;
  fallback: number;
}

export async function backfillAuditLogClubId(
  db: DataSource,
  options: { auditTable?: string; usersTable?: string } = {},
): Promise<AuditLogTenantBackfillResult | null> {
  const auditTable = options.auditTable ?? 'match_audit_log';
  const usersTable = options.usersTable ?? 'users';

  const tables = await db.query(
    'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [auditTable],
  );
  if (Number(tables[0]?.n) === 0) {
    return null;
  }

  const joinedRows = await db.query(
    `UPDATE ${auditTable} l JOIN ${usersTable} u ON u.id = l.userId
     SET l.clubId = u.clubId
     WHERE l.clubId IS NULL OR l.clubId = ''`,
  );
  const fallbackRows = await db.query(
    `UPDATE ${auditTable} SET clubId = ? WHERE clubId IS NULL OR clubId = ''`,
    [defaultClubId()],
  );
  const joined = Number(joinedRows?.affectedRows ?? 0);
  const fallback = Number(fallbackRows?.affectedRows ?? 0);
  if (fallback > 0) {
    console.warn(
      `[migration 0009] ${fallback} entrée(s) d'audit sans auteur résolu rattachée(s) au club par défaut`,
    );
  }
  return { joined, fallback };
}
