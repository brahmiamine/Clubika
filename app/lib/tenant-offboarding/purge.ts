import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import { hashClubId, offboardingBatchSize, TOMBSTONE_CLUB_NAME } from './constants';
import { OffboardingError } from './errors';
import { recordOffboardingEvent } from './events';
import { latestExportManifest } from './export';
import { inventoryClub, countStore, purgableStores, type StoreCount, type TenantStoreSpec } from './inventory';
import { listProcessorInstructions } from './processors';
import { deleteBatches, deleteBySelect, tableExists } from './sql';

export interface PurgeStoreResult {
  id: string;
  scanned: number;
  deleted: number;
  dryRun: boolean;
  error?: string;
}

export interface PurgeReport {
  dryRun: boolean;
  success: boolean;
  startedAt: string;
  finishedAt: string;
  stores: PurgeStoreResult[];
  certificate?: Record<string, unknown>;
}

function placeholders(count: number): string {
  return ids(count);
}

function ids(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

async function purgeStore(
  db: DataSource,
  store: TenantStoreSpec,
  clubId: string,
  dryRun: boolean,
  batchSize: number,
): Promise<PurgeStoreResult> {
  const scanned = Number((await countStore(db, store, clubId)) ?? 0);
  if (dryRun || scanned === 0 || !store.table) {
    return { id: store.id, scanned, deleted: 0, dryRun };
  }
  if (!(await tableExists(db, store.table))) {
    return { id: store.id, scanned: 0, deleted: 0, dryRun };
  }

  try {
    let deleted = 0;
    if (store.scope === 'club_id') {
      deleted = await deleteBatches(
        db,
        `DELETE FROM ${store.table} WHERE club_id = ? LIMIT ?`,
        [clubId],
        batchSize,
      );
    } else if (store.scope === 'clubId') {
      deleted = await deleteBatches(
        db,
        `DELETE FROM ${store.table} WHERE clubId = ? LIMIT ?`,
        [clubId],
        batchSize,
      );
    } else if (store.scope === 'via_rooms') {
      deleted = await purgeViaRooms(db, store.id, clubId, batchSize);
    } else if (store.scope === 'via_users') {
      deleted = await purgeViaUsers(db, store.id, clubId, batchSize);
    }
    return { id: store.id, scanned, deleted, dryRun };
  } catch (error) {
    return {
      id: store.id,
      scanned,
      deleted: 0,
      dryRun,
      error: error instanceof Error ? error.message : 'purge failed',
    };
  }
}

async function purgeViaRooms(db: DataSource, id: string, clubId: string, batchSize: number): Promise<number> {
  if (id === 'chat_message_reactions') {
    return deleteBySelect(db, {
      selectSql: `SELECT x.messageId AS id FROM chat_message_reactions x
        INNER JOIN chat_messages m ON m.id = x.messageId
        INNER JOIN chat_rooms r ON r.id = m.roomId
        WHERE r.clubId = ? LIMIT ?`,
      selectParams: [clubId],
      deleteSql: (messageIds) => ({
        sql: `DELETE FROM chat_message_reactions WHERE messageId IN (${placeholders(messageIds.length)})`,
        params: messageIds,
      }),
      batchSize,
    });
  }
  if (id === 'chat_read_states') {
    return deleteBySelect(db, {
      selectSql: `SELECT x.roomId AS id FROM chat_read_states x
        INNER JOIN chat_rooms r ON r.id = x.roomId WHERE r.clubId = ? LIMIT ?`,
      selectParams: [clubId],
      deleteSql: (roomIds) => ({
        sql: `DELETE FROM chat_read_states WHERE roomId IN (${placeholders(roomIds.length)})`,
        params: roomIds,
      }),
      batchSize,
    });
  }
  if (id === 'chat_messages') {
    return deleteBySelect(db, {
      selectSql: `SELECT m.id AS id FROM chat_messages m
        INNER JOIN chat_rooms r ON r.id = m.roomId WHERE r.clubId = ? LIMIT ?`,
      selectParams: [clubId],
      deleteSql: (messageIds) => ({
        sql: `DELETE FROM chat_messages WHERE id IN (${placeholders(messageIds.length)})`,
        params: messageIds,
      }),
      batchSize,
    });
  }
  if (id === 'chat_participants') {
    return deleteBySelect(db, {
      selectSql: `SELECT x.roomId AS id FROM chat_participants x
        INNER JOIN chat_rooms r ON r.id = x.roomId WHERE r.clubId = ? LIMIT ?`,
      selectParams: [clubId],
      deleteSql: (roomIds) => ({
        sql: `DELETE FROM chat_participants WHERE roomId IN (${placeholders(roomIds.length)})`,
        params: roomIds,
      }),
      batchSize,
    });
  }
  return 0;
}

async function purgeViaUsers(db: DataSource, id: string, clubId: string, batchSize: number): Promise<number> {
  const specs: Record<string, { select: string; delete: (ids: string[]) => { sql: string; params: unknown[] }; key: string }> = {
    password_reset_tokens: {
      key: 'id',
      select: `SELECT x.tokenHash AS id FROM password_reset_tokens x INNER JOIN users u ON u.id = x.userId WHERE u.clubId = ? LIMIT ?`,
      delete: (tokenHashes) => ({
        sql: `DELETE FROM password_reset_tokens WHERE tokenHash IN (${placeholders(tokenHashes.length)})`,
        params: tokenHashes,
      }),
    },
    push_subscriptions: {
      key: 'id',
      select: `SELECT x.id AS id FROM push_subscriptions x INNER JOIN users u ON u.id = x.user_id WHERE u.clubId = ? LIMIT ?`,
      delete: (rowIds) => ({
        sql: `DELETE FROM push_subscriptions WHERE id IN (${placeholders(rowIds.length)})`,
        params: rowIds,
      }),
    },
    planning_notification_outbox: {
      key: 'id',
      select: `SELECT x.id AS id FROM planning_notification_outbox x INNER JOIN users u ON u.id = x.user_id WHERE u.clubId = ? LIMIT ?`,
      delete: (rowIds) => ({
        sql: `DELETE FROM planning_notification_outbox WHERE id IN (${placeholders(rowIds.length)})`,
        params: rowIds,
      }),
    },
    notifications: {
      key: 'id',
      select: `SELECT x.id AS id FROM notifications x INNER JOIN users u ON u.id = x.userId WHERE u.clubId = ? LIMIT ?`,
      delete: (rowIds) => ({
        sql: `DELETE FROM notifications WHERE id IN (${placeholders(rowIds.length)})`,
        params: rowIds,
      }),
    },
    user_sessions: {
      key: 'id',
      select: `SELECT x.id AS id FROM user_sessions x INNER JOIN users u ON u.id = x.userId WHERE u.clubId = ? LIMIT ?`,
      delete: (rowIds) => ({
        sql: `DELETE FROM user_sessions WHERE id IN (${placeholders(rowIds.length)})`,
        params: rowIds,
      }),
    },
  };
  const spec = specs[id];
  if (!spec) return 0;
  return deleteBySelect(db, {
    selectSql: spec.select,
    selectParams: [clubId],
    deleteSql: spec.delete,
    batchSize,
    idKey: spec.key,
  });
}

async function tombstoneTenant(db: DataSource, tenant: ClubTenantEntity): Promise<void> {
  tenant.name = TOMBSTONE_CLUB_NAME;
  tenant.abbreviation = '';
  tenant.description = '';
  tenant.logo = '';
  tenant.themeMode = 'system';
  tenant.primaryColor = '#1f2937';
  tenant.secondaryColor = '#e5e7eb';
  tenant.matchesUrlKey = '';
  tenant.scraperClubName = '';
  tenant.featuresJson = '{}';
  tenant.smtpHost = null;
  tenant.smtpPort = null;
  tenant.smtpSecure = false;
  tenant.smtpUser = null;
  tenant.smtpPasswordEncrypted = null;
  tenant.smtpFromEmail = null;
  tenant.smtpFromName = null;
  tenant.active = false;
  tenant.offboardingStatus = 'purged';
  tenant.purgedAt = new Date();
  await db.getRepository<ClubTenantEntity>('ClubTenant').save(tenant);
}

export function assertPurgeAllowed(
  tenant: ClubTenantEntity,
  options: { overrideRetention: boolean; now?: Date },
): void {
  if (tenant.offboardingStatus === 'purged') return;
  if (tenant.offboardingStatus !== 'frozen') {
    throw new OffboardingError('Le club doit être gelé avant suppression', 409);
  }
  if (tenant.legalHoldActive) {
    throw new OffboardingError('Legal hold actif : suppression refusée', 409);
  }
  const now = options.now ?? new Date();
  if (tenant.legalHoldExpiresAt && tenant.legalHoldActive) {
    throw new OffboardingError('Legal hold actif : suppression refusée', 409);
  }
  if (!options.overrideRetention) {
    if (!tenant.retentionUntil) {
      throw new OffboardingError(
        'Aucune date de rétention produit n’est définie. Indiquez-en une au gel, ou confirmez un override humain.',
        409,
      );
    }
    if (tenant.retentionUntil.getTime() > now.getTime()) {
      throw new OffboardingError('La période de rétention produit n’est pas écoulée', 409);
    }
  }
}

export async function purgeClub(
  db: DataSource,
  clubId: string,
  options: {
    dryRun: boolean;
    overrideRetention: boolean;
    confirmClubId?: string;
    platformAdminId: number | null;
  },
): Promise<PurgeReport> {
  const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
  const tenant = await repo.findOneBy({ id: clubId });
  if (!tenant) throw new OffboardingError('Club non trouvé', 404);

  if (!options.dryRun && options.confirmClubId !== clubId) {
    throw new OffboardingError('Confirmation de l’identifiant club requise', 400);
  }

  if (tenant.offboardingStatus === 'purged' && !options.dryRun) {
    const existing = await loadCertificate(db, clubId);
    return {
      dryRun: false,
      success: true,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      stores: [],
      certificate: existing ?? undefined,
    };
  }

  assertPurgeAllowed(tenant, { overrideRetention: options.overrideRetention });

  const startedAt = new Date();
  const batchSize = offboardingBatchSize();
  const stores: PurgeStoreResult[] = [];
  for (const store of purgableStores()) {
    stores.push(await purgeStore(db, store, clubId, options.dryRun, batchSize));
  }

  const failed = stores.filter((row) => row.error);
  let certificate: Record<string, unknown> | undefined;
  if (!options.dryRun && failed.length === 0) {
    await tombstoneTenant(db, tenant);
    certificate = await writeCertificate(db, tenant, stores, options.platformAdminId);
  }

  const finishedAt = new Date();
  await recordOffboardingEvent(db, {
    clubId,
    action: options.dryRun ? 'purge-dry-run' : 'purge',
    platformAdminId: options.platformAdminId,
    payload: {
      dryRun: options.dryRun,
      overrideRetention: options.overrideRetention,
      storeCount: stores.length,
      failed: failed.map((row) => row.id),
    },
  });

  return {
    dryRun: options.dryRun,
    success: failed.length === 0,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stores,
    certificate,
  };
}

export async function writeCertificate(
  db: DataSource,
  tenant: ClubTenantEntity,
  stores: PurgeStoreResult[],
  platformAdminId: number | null,
): Promise<Record<string, unknown>> {
  const processors = await listProcessorInstructions(db, tenant.id);
  const residual: StoreCount[] = await inventoryClub(db, tenant.id);
  const payload = {
    version: 1,
    clubId: tenant.id,
    clubIdHash: hashClubId(tenant.id),
    frozenAt: tenant.frozenAt?.toISOString() ?? null,
    purgedAt: tenant.purgedAt?.toISOString() ?? new Date().toISOString(),
    exportManifestSha256: await latestExportManifest(db, tenant.id),
    stores: stores.map((row) => ({ id: row.id, scanned: row.scanned, deleted: row.deleted })),
    residual: residual
      .filter((row) => !row.documentedOnly)
      .map((row) => ({ id: row.id, remaining: row.scanned })),
    processors: processors.map((row) => ({
      id: row.id,
      status: row.status,
      instructedAt: row.instructedAt,
      responseAt: row.responseAt,
    })),
  };
  const existing = await db.getRepository('TenantDeletionCertificate').findOneBy({ clubId: tenant.id });
  if (existing) {
    existing.payloadJson = JSON.stringify(payload);
    existing.clubIdHash = payload.clubIdHash;
    await db.getRepository('TenantDeletionCertificate').save(existing);
  } else {
    await db.getRepository('TenantDeletionCertificate').save({
      id: randomUUID(),
      clubId: tenant.id,
      clubIdHash: payload.clubIdHash,
      createdByPlatformAdminId: platformAdminId,
      payloadJson: JSON.stringify(payload),
    });
  }
  return payload;
}

export async function loadCertificate(db: DataSource, clubId: string): Promise<Record<string, unknown> | null> {
  const row = await db.getRepository('TenantDeletionCertificate').findOneBy({ clubId });
  if (!row) return null;
  try {
    return JSON.parse(String(row.payloadJson)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function listFrozenClubsDue(db: DataSource): Promise<string[]> {
  const rows = await db.query(
    `SELECT id FROM club_tenants
      WHERE offboardingStatus = 'frozen'
        AND legalHoldActive = 0
        AND retentionUntil IS NOT NULL
        AND retentionUntil <= NOW()`,
  ) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export async function residualSearchHits(db: DataSource, clubId: string, needles: string[]): Promise<string[]> {
  const hits: string[] = [];
  const tables: Array<{ table: string; sql: string }> = [
    { table: 'users', sql: 'SELECT email, nom, telephone FROM users WHERE clubId = ?' },
    { table: 'invitations', sql: 'SELECT email, personNom FROM invitations WHERE clubId = ?' },
    { table: 'match_audit_log', sql: 'SELECT userEmail, userNom FROM match_audit_log WHERE clubId = ?' },
    { table: 'planning_records', sql: 'SELECT payload FROM planning_records WHERE club_id = ?' },
    { table: 'club_tenants', sql: 'SELECT name, smtpUser, smtpFromEmail FROM club_tenants WHERE id = ?' },
  ];
  for (const entry of tables) {
    if (!(await tableExists(db, entry.table))) continue;
    const rows = await db.query(entry.sql, [clubId]) as Array<Record<string, unknown>>;
    const blob = JSON.stringify(rows).toLowerCase();
    for (const needle of needles) {
      if (needle && blob.includes(needle.toLowerCase())) hits.push(`${entry.table}:${needle}`);
    }
  }
  return hits;
}
