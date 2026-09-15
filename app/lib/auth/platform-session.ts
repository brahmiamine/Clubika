import { randomBytes } from 'node:crypto';
import { getDb } from '@/lib/db';
import { PlatformAdminEntity, PlatformSessionEntity } from '@/lib/db/schemas';

export { PLATFORM_SESSION_COOKIE_NAME, PLATFORM_MFA_PENDING_COOKIE_NAME } from './constants';

export interface PlatformAdminSessionUser {
  id: number;
  email: string;
  nom: string;
  active: boolean;
}

function getPlatformSessionTtlMs(): number {
  const rawDays = process.env.PLATFORM_SESSION_TTL_DAYS;
  const days = rawDays ? Number.parseInt(rawDays, 10) : 30;
  const safeDays = Number.isFinite(days) && days > 0 ? days : 30;
  return safeDays * 24 * 60 * 60 * 1000;
}

function toPlatformAdminSessionUser(admin: PlatformAdminEntity): PlatformAdminSessionUser {
  return {
    id: admin.id,
    email: admin.email,
    nom: admin.nom,
    active: admin.active,
  };
}

export async function createPlatformSession(
  platformAdminId: number,
  // Accepted for signature parity with `createSession`; not persisted since
  // `platform_sessions` has no userAgent/ipAddress columns.
  meta?: { userAgent?: string | null; ipAddress?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  void meta;
  const db = await getDb();
  const repo = db.getRepository<PlatformSessionEntity>('PlatformSession');

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + getPlatformSessionTtlMs());

  await repo.save({
    id: token,
    platformAdminId,
    expiresAt,
    revokedAt: null,
    authenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  });

  return { token, expiresAt };
}

export async function getPlatformSessionAdmin(
  token: string | undefined | null,
): Promise<PlatformAdminSessionUser | null> {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    return null;
  }

  const db = await getDb();
  const sessionRepo = db.getRepository<PlatformSessionEntity>('PlatformSession');
  const adminRepo = db.getRepository<PlatformAdminEntity>('PlatformAdmin');

  const session = await sessionRepo.findOneBy({ id: token });
  if (!session || session.revokedAt !== null) {
    return null;
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  const admin = await adminRepo.findOneBy({ id: session.platformAdminId });
  if (!admin || !admin.active) {
    return null;
  }

  return toPlatformAdminSessionUser(admin);
}

export async function revokePlatformSession(token: string | undefined | null): Promise<void> {
  if (!token) {
    return;
  }
  const db = await getDb();
  const repo = db.getRepository<PlatformSessionEntity>('PlatformSession');
  const session = await repo.findOneBy({ id: token });
  if (session && session.revokedAt === null) {
    session.revokedAt = new Date();
    await repo.save(session);
  }
}

export async function revokeAllPlatformSessionsForAdmin(platformAdminId: number): Promise<void> {
  const db = await getDb();
  await db.getRepository<PlatformSessionEntity>('PlatformSession')
    .createQueryBuilder()
    .update()
    .set({ revokedAt: new Date() })
    .where('platformAdminId = :platformAdminId', { platformAdminId })
    .andWhere('revokedAt IS NULL')
    .execute();
}
