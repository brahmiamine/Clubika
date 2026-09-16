import { createHash, randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import { encryptSecret } from '@/lib/crypto/secret-box';
import type { TenantOffboardingExportEntity } from '@/lib/db/schemas';
import { EXPORT_TTL_MS, hashClubId } from './constants';
import { OffboardingError } from './errors';
import { recordOffboardingEvent } from './events';
import { tableExists } from './sql';

const USER_EXPORT_COLUMNS = [
  'id', 'clubId', 'email', 'nom', 'accessRole', 'planningFunctions',
  'active', 'claimedAt', 'telephone', 'indisponibilites', 'notifyChannel',
  'createdAt', 'updatedAt',
];

async function selectAll(
  db: DataSource,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown>[]> {
  return db.query(sql, params) as Promise<Record<string, unknown>[]>;
}

async function loadTenantBundle(db: DataSource, clubId: string): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};

  if (await tableExists(db, 'club_tenants')) {
    const rows = await selectAll(
      db,
      `SELECT id, name, abbreviation, description, logo, themeMode, primaryColor, secondaryColor,
              timeZone, matchesUrlKey, scraperClubName, featuresJson, smtpHost, smtpPort, smtpSecure,
              smtpUser, smtpFromEmail, smtpFromName, active, createdAt, updatedAt,
              CASE WHEN smtpPasswordEncrypted IS NULL OR smtpPasswordEncrypted = '' THEN 0 ELSE 1 END AS smtpConfigured
         FROM club_tenants WHERE id = ?`,
      [clubId],
    );
    data.club_tenants = rows;
  }

  const directClubId = [
    ['users', `SELECT ${USER_EXPORT_COLUMNS.join(', ')} FROM users WHERE clubId = ?`],
    ['invitations', 'SELECT id, clubId, email, accessRole, planningFunctions, personNom, personType, personId, expiresAt, usedAt, createdAt FROM invitations WHERE clubId = ?'],
    ['clubs', 'SELECT id, clubId, nom, logo, createdAt, updatedAt FROM clubs WHERE clubId = ?'],
    ['categories', 'SELECT id, clubId, value, createdAt, updatedAt FROM categories WHERE clubId = ?'],
    ['stades', 'SELECT id, clubId, nom, adresse, googleMapsUrl, createdAt, updatedAt FROM stades WHERE clubId = ?'],
    ['matches_officiels', 'SELECT clubId, id, date, time, sourceMatchId, payload, createdAt, updatedAt FROM matches_officiels WHERE clubId = ?'],
    ['matches_amicaux', 'SELECT clubId, id, date, time, payload, createdAt, updatedAt FROM matches_amicaux WHERE clubId = ?'],
    ['entrainements', 'SELECT clubId, id, date, time, payload, createdAt, updatedAt FROM entrainements WHERE clubId = ?'],
    ['plateaux', 'SELECT clubId, id, date, time, payload, createdAt, updatedAt FROM plateaux WHERE clubId = ?'],
    ['matches_extras', 'SELECT clubId, matchId, payload, createdAt, updatedAt FROM matches_extras WHERE clubId = ?'],
    ['match_audit_log', 'SELECT id, clubId, entityType, entityId, action, userId, createdAt FROM match_audit_log WHERE clubId = ?'],
    ['chat_rooms', 'SELECT id, type, clubId, roomKey, name, description, eventType, eventId, createdAt, updatedAt FROM chat_rooms WHERE clubId = ?'],
  ] as const;

  for (const [key, sql] of directClubId) {
    if (await tableExists(db, key)) data[key] = await selectAll(db, sql, [clubId]);
  }

  const clubUnderscore = [
    ['planning_records', 'SELECT id, club_id, kind, event_type, event_id, owner_user_id, person_type, person_id, payload, created_at, updated_at FROM planning_records WHERE club_id = ?'],
    ['planning_event_state', 'SELECT club_id, event_type, event_id, archived_at, created_at, updated_at FROM planning_event_state WHERE club_id = ?'],
    ['planning_assignment_state', 'SELECT club_id, event_type, event_id, role, person_key, person_type, person_id, person_name, state, created_at, updated_at FROM planning_assignment_state WHERE club_id = ?'],
    ['planning_attachments', 'SELECT id, club_id, event_type, event_id, file_name, mime_type, size_bytes, TO_BASE64(content) AS content_base64, uploaded_by_user_id, created_at FROM planning_attachments WHERE club_id = ?'],
    ['chat_attachments', 'SELECT id, club_id, room_id, kind, file_name, mime_type, size_bytes, TO_BASE64(content) AS content_base64, uploaded_by_user_id, created_at FROM chat_attachments WHERE club_id = ?'],
    ['scraper_sync_runs', 'SELECT id, club_id, status, started_at, finished_at FROM scraper_sync_runs WHERE club_id = ?'],
  ] as const;

  for (const [key, sql] of clubUnderscore) {
    if (await tableExists(db, key)) data[key] = await selectAll(db, sql, [clubId]);
  }

  if (await tableExists(db, 'chat_messages')) {
    data.chat_messages = await selectAll(
      db,
      `SELECT m.id, m.roomId, m.senderUserId, m.content, m.createdAt
         FROM chat_messages m INNER JOIN chat_rooms r ON r.id = m.roomId
        WHERE r.clubId = ?`,
      [clubId],
    );
  }
  if (await tableExists(db, 'notifications')) {
    data.notifications = await selectAll(
      db,
      `SELECT n.id, n.userId, n.type, n.title, n.message, n.eventType, n.eventId, n.readAt, n.createdAt
         FROM notifications n INNER JOIN users u ON u.id = n.userId
        WHERE u.clubId = ?`,
      [clubId],
    );
  }

  return data;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

export async function issueExportToken(
  db: DataSource,
  clubId: string,
  platformAdminId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const tenant = await db.getRepository('ClubTenant').findOneBy({ id: clubId });
  if (!tenant) throw new OffboardingError('Club non trouvé', 404);
  if (tenant.offboardingStatus === 'purged') {
    throw new OffboardingError('Impossible d’exporter : le club est déjà supprimé', 409);
  }

  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
  const repo = db.getRepository<TenantOffboardingExportEntity>('TenantOffboardingExport');
  await repo.save({
    id: tokenHash,
    clubId,
    createdByPlatformAdminId: platformAdminId,
    expiresAt,
    usedAt: null,
    revokedAt: null,
    manifestSha256: null,
    byteLength: null,
  });
  await recordOffboardingEvent(db, {
    clubId,
    action: 'export-issued',
    platformAdminId,
    payload: { expiresAt: expiresAt.toISOString() },
  });
  return { token, expiresAt };
}

export async function consumeExport(
  db: DataSource,
  token: string,
): Promise<{ body: string; manifestSha256: string; clubId: string }> {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const repo = db.getRepository<TenantOffboardingExportEntity>('TenantOffboardingExport');
  const row = await repo.findOneBy({ id: tokenHash });
  if (!row) throw new OffboardingError('Lien d’export introuvable', 404);
  if (row.revokedAt) throw new OffboardingError('Lien d’export révoqué', 410);
  if (row.usedAt) throw new OffboardingError('Lien d’export déjà utilisé', 410);
  if (row.expiresAt.getTime() <= Date.now()) throw new OffboardingError('Lien d’export expiré', 410);

  const tenant = await db.getRepository('ClubTenant').findOneBy({ id: row.clubId });
  if (!tenant || tenant.offboardingStatus === 'purged') {
    throw new OffboardingError('Les données du club ne sont plus disponibles', 410);
  }

  const bundle = await loadTenantBundle(db, row.clubId);
  const inner = {
    version: 1,
    generatedAt: new Date().toISOString(),
    clubId: row.clubId,
    clubIdHash: hashClubId(row.clubId),
    data: bundle,
  };
  const innerJson = canonicalJson(inner);
  const manifestSha256 = createHash('sha256').update(innerJson).digest('hex');
  const envelope = {
    version: 1,
    clubIdHash: hashClubId(row.clubId),
    manifestSha256,
    ciphertext: encryptSecret(innerJson),
  };
  const body = JSON.stringify(envelope);
  row.usedAt = new Date();
  row.manifestSha256 = manifestSha256;
  row.byteLength = Buffer.byteLength(body);
  await repo.save(row);
  await recordOffboardingEvent(db, {
    clubId: row.clubId,
    action: 'export-downloaded',
    platformAdminId: row.createdByPlatformAdminId,
    payload: { manifestSha256, byteLength: row.byteLength },
  });
  return { body, manifestSha256, clubId: row.clubId };
}

export async function latestExportManifest(db: DataSource, clubId: string): Promise<string | null> {
  const rows = await db.query(
    `SELECT manifestSha256 FROM tenant_offboarding_exports
      WHERE clubId = ? AND manifestSha256 IS NOT NULL
      ORDER BY createdAt DESC LIMIT 1`,
    [clubId],
  ) as Array<{ manifestSha256: string }>;
  return rows[0]?.manifestSha256 ?? null;
}
