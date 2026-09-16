import type { DataSource } from 'typeorm';
import type { PrivacyExportTokenEntity, UserEntity } from '@/lib/db/schemas';
import {
  hashPrivacyToken,
  newPrivacyToken,
  PRIVACY_EXPORT_TTL_MS,
} from './catalog';
import { buildSubjectExport, subjectExportToHtml } from './export';

export async function issueExportToken(
  db: DataSource,
  user: UserEntity,
  requestId: string,
): Promise<{ token: string; expiresAt: Date; downloadPath: string }> {
  const token = newPrivacyToken();
  const expiresAt = new Date(Date.now() + PRIVACY_EXPORT_TTL_MS);
  await db.getRepository<PrivacyExportTokenEntity>('PrivacyExportToken').save({
    id: hashPrivacyToken(token),
    clubId: user.clubId,
    userId: user.id,
    requestId,
    expiresAt,
    revokedAt: null,
    downloadedAt: null,
  });
  return { token, expiresAt, downloadPath: `/api/privacy/exports/${token}` };
}

export async function revokeExportToken(db: DataSource, tokenHash: string, clubId: string): Promise<boolean> {
  const repo = db.getRepository<PrivacyExportTokenEntity>('PrivacyExportToken');
  const row = await repo.findOneBy({ id: tokenHash, clubId });
  if (!row) return false;
  row.revokedAt = new Date();
  await repo.save(row);
  return true;
}

export async function consumeExportDownload(
  db: DataSource,
  rawToken: string,
  format: 'json' | 'html',
): Promise<{ body: string; contentType: string } | { error: 'missing' | 'expired' | 'revoked' | 'used' }> {
  const repo = db.getRepository<PrivacyExportTokenEntity>('PrivacyExportToken');
  const row = await repo.findOneBy({ id: hashPrivacyToken(rawToken) });
  if (!row) return { error: 'missing' };
  if (row.revokedAt) return { error: 'revoked' };
  if (new Date(row.expiresAt).getTime() <= Date.now()) return { error: 'expired' };
  if (row.downloadedAt) return { error: 'used' };

  const user = await db.getRepository<UserEntity>('User').findOneBy({ id: row.userId, clubId: row.clubId });
  if (!user) return { error: 'missing' };

  const payload = await buildSubjectExport(db, user);
  row.downloadedAt = new Date();
  await repo.save(row);

  if (format === 'html') {
    return { body: subjectExportToHtml(payload), contentType: 'text/html; charset=utf-8' };
  }
  return { body: JSON.stringify(payload, null, 2), contentType: 'application/json; charset=utf-8' };
}
