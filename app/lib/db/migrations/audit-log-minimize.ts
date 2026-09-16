import type { DataSource, EntityManager } from 'typeorm';
import { auditPayloadsEqual, minimizeAuditPayload } from '@/lib/audit/minimize';
import type { MatchAuditLogEntity } from '@/lib/db/schemas';
import { logInfo } from '@/lib/observability/log';

export interface SanitizeHistoricalAuditLogsResult {
  scanned: number;
  actorCleared: number;
  payloadRedacted: number;
  mutated: number;
}

export interface SanitizeHistoricalAuditLogsOptions {
  /** Inventaire seulement : aucun UPDATE. */
  dryRun?: boolean;
  /** Taille de page TypeORM (défaut 200). */
  batchSize?: number;
  /** Restreint le passage à un `entityId` (tests). */
  entityId?: string;
}

function hasActorPii(row: MatchAuditLogEntity): boolean {
  return row.userEmail != null || row.userNom != null;
}

/**
 * Migration 0037 (issue #20) — assainit les journaux d'audit existants.
 *
 * 1. Inventaire (dry-run) : compte les lignes dont l'acteur nominatif ou le
 *    payload n'est pas conforme au catalogue v1.
 * 2. Application : NULL `userEmail`/`userNom`, réécrit `before`/`after`
 *    minimisés. Idempotent. Pas de table miroir nominative (cela recopierait
 *    des données personnelles) : le retour arrière opérationnel est une
 *    restauration de sauvegarde prise avant migrate, testée ici sur une copie
 *    de lignes synthétiques.
 */
export async function sanitizeHistoricalAuditLogs(
  db: DataSource | EntityManager,
  options: SanitizeHistoricalAuditLogsOptions = {},
): Promise<SanitizeHistoricalAuditLogsResult> {
  const dryRun = options.dryRun === true;
  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 1000));
  const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
  const where = options.entityId ? { entityId: options.entityId } : {};

  const result: SanitizeHistoricalAuditLogsResult = {
    scanned: 0,
    actorCleared: 0,
    payloadRedacted: 0,
    mutated: 0,
  };

  const total = await repo.count({ where });
  for (let skip = 0; skip < total; skip += batchSize) {
    const rows = await repo.find({
      where,
      order: { id: 'ASC' },
      skip,
      take: batchSize,
    });
    const dirty: MatchAuditLogEntity[] = [];
    for (const row of rows) {
      result.scanned += 1;
      const nextBefore = minimizeAuditPayload(row.before);
      const nextAfter = minimizeAuditPayload(row.after);
      const actorDirty = hasActorPii(row);
      const payloadDirty = !auditPayloadsEqual(row.before, nextBefore)
        || !auditPayloadsEqual(row.after, nextAfter);
      if (actorDirty) result.actorCleared += 1;
      if (payloadDirty) result.payloadRedacted += 1;
      if (!actorDirty && !payloadDirty) continue;
      result.mutated += 1;
      row.userEmail = null;
      row.userNom = null;
      row.before = nextBefore;
      row.after = nextAfter;
      dirty.push(row);
    }
    if (!dryRun && dirty.length > 0) {
      await repo.save(dirty);
    }
  }

  return result;
}

export async function applyAuditLogMinimizeMigration(db: DataSource): Promise<void> {
  const tables = await db.query(
    "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'match_audit_log'",
  );
  if (Number(tables[0]?.n) === 0) return;

  const inventory = await sanitizeHistoricalAuditLogs(db, { dryRun: true });
  logInfo('app.unhandled',
    `[migration 0037] inventaire audit : scanned=${inventory.scanned} actorCleared=${inventory.actorCleared} payloadRedacted=${inventory.payloadRedacted} mutated=${inventory.mutated}`,
  );
  const applied = await sanitizeHistoricalAuditLogs(db, { dryRun: false });
  logInfo('app.unhandled',
    `[migration 0037] application audit : scanned=${applied.scanned} actorCleared=${applied.actorCleared} payloadRedacted=${applied.payloadRedacted} mutated=${applied.mutated}`,
  );
}
