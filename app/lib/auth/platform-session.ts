import { randomUUID } from 'node:crypto';
import { In, IsNull } from 'typeorm';
import { getDb } from '@/lib/db';
import { PlatformAdminEntity, PlatformSessionEntity } from '@/lib/db/schemas';
import { coarseClientHint, dayStamp, networkHint } from './session-meta';
import {
  generateSessionToken,
  hashSessionToken,
  isPlausibleSessionToken,
  sessionTokenHashCandidates,
  sessionTokenHashesEqual,
} from './session-token';
import { sessionTtlSeconds } from './session-ttl';
import type { PublicSessionInfo } from './session';

export { PLATFORM_SESSION_COOKIE_NAME, PLATFORM_MFA_PENDING_COOKIE_NAME } from './constants';

export interface PlatformAdminSessionUser {
  id: number;
  email: string;
  nom: string;
  active: boolean;
}

const LAST_SEEN_TOUCH_MS = 60_000;

function toPlatformAdminSessionUser(admin: PlatformAdminEntity): PlatformAdminSessionUser {
  return {
    id: admin.id,
    email: admin.email,
    nom: admin.nom,
    active: admin.active,
  };
}

function sessionIsExpired(session: PlatformSessionEntity, now = Date.now()): boolean {
  const lastSeen = new Date(session.lastSeenAt ?? session.createdAt).getTime();
  const created = new Date(session.createdAt).getTime();
  const idleDeadline = lastSeen + session.idleTtlSeconds * 1000;
  const absoluteDeadline = Math.min(
    new Date(session.expiresAt).getTime(),
    created + session.absoluteTtlSeconds * 1000,
  );
  return now >= idleDeadline || now >= absoluteDeadline;
}

async function findSessionByToken(token: string): Promise<PlatformSessionEntity | null> {
  const db = await getDb();
  const repo = db.getRepository<PlatformSessionEntity>('PlatformSession');
  const candidates = sessionTokenHashCandidates(token);
  const sessions = await repo.find({ where: { tokenHash: In(candidates) } });
  for (const session of sessions) {
    if (candidates.some((digest) => sessionTokenHashesEqual(session.tokenHash, digest))) {
      return session;
    }
  }
  return null;
}

export async function createPlatformSession(
  platformAdminId: number,
  meta?: { userAgent?: string | null; ipAddress?: string | null },
): Promise<{ token: string; expiresAt: Date; id: string }> {
  const db = await getDb();
  const repo = db.getRepository<PlatformSessionEntity>('PlatformSession');
  const ttl = sessionTtlSeconds('platform');

  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl.absolute * 1000);

  const saved = await repo.save({
    id: randomUUID(),
    tokenHash: hashSessionToken(token),
    platformAdminId,
    lastSeenAt: now,
    expiresAt,
    idleTtlSeconds: ttl.idle,
    absoluteTtlSeconds: ttl.absolute,
    revokedAt: null,
    clientHint: coarseClientHint(meta?.userAgent),
    networkHint: networkHint(meta?.ipAddress),
    authenticatedAt: new Date(),
    mfaVerifiedAt: new Date(),
  });

  return { token, expiresAt, id: saved.id };
}

export async function getPlatformSessionAdmin(
  token: string | undefined | null,
): Promise<PlatformAdminSessionUser | null> {
  if (!isPlausibleSessionToken(token)) {
    return null;
  }

  const db = await getDb();
  const session = await findSessionByToken(token);
  if (!session || session.revokedAt !== null) {
    return null;
  }
  if (sessionIsExpired(session)) {
    session.revokedAt = new Date();
    await db.getRepository<PlatformSessionEntity>('PlatformSession').save(session);
    return null;
  }

  const admin = await db.getRepository<PlatformAdminEntity>('PlatformAdmin').findOneBy({
    id: session.platformAdminId,
  });
  if (!admin || !admin.active) {
    return null;
  }

  const lastSeenMs = new Date(session.lastSeenAt ?? session.createdAt).getTime();
  if (Date.now() - lastSeenMs >= LAST_SEEN_TOUCH_MS) {
    const touched = new Date();
    await db.getRepository<PlatformSessionEntity>('PlatformSession').update(
      { id: session.id },
      { lastSeenAt: touched },
    );
  }

  return toPlatformAdminSessionUser(admin);
}

export async function revokePlatformSession(token: string | undefined | null): Promise<void> {
  if (!isPlausibleSessionToken(token)) {
    return;
  }
  const session = await findSessionByToken(token);
  if (session && session.revokedAt === null) {
    const db = await getDb();
    session.revokedAt = new Date();
    await db.getRepository<PlatformSessionEntity>('PlatformSession').save(session);
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

export async function revokePlatformSessionById(adminId: number, sessionId: string): Promise<boolean> {
  const db = await getDb();
  const repo = db.getRepository<PlatformSessionEntity>('PlatformSession');
  const session = await repo.findOneBy({ id: sessionId, platformAdminId: adminId });
  if (!session || session.revokedAt !== null) return false;
  session.revokedAt = new Date();
  await repo.save(session);
  return true;
}

export async function revokeOtherPlatformSessions(adminId: number, currentToken: string): Promise<number> {
  const current = await findSessionByToken(currentToken);
  const db = await getDb();
  const result = await db.getRepository<PlatformSessionEntity>('PlatformSession')
    .createQueryBuilder()
    .update()
    .set({ revokedAt: new Date() })
    .where('platformAdminId = :adminId', { adminId })
    .andWhere('revokedAt IS NULL')
    .andWhere(current ? 'id != :currentId' : '1=1', current ? { currentId: current.id } : {})
    .execute();
  return Number(result.affected ?? 0);
}

export async function listPublicPlatformSessions(
  adminId: number,
  currentToken?: string | null,
): Promise<PublicSessionInfo[]> {
  const db = await getDb();
  const sessions = await db.getRepository<PlatformSessionEntity>('PlatformSession').find({
    where: { platformAdminId: adminId, revokedAt: IsNull() },
    order: { lastSeenAt: 'DESC' },
  });
  const current = currentToken && isPlausibleSessionToken(currentToken)
    ? await findSessionByToken(currentToken)
    : null;
  const now = Date.now();
  return sessions
    .filter((session) => !sessionIsExpired(session, now))
    .map((session) => ({
      id: session.id,
      current: current?.id === session.id,
      clientHint: session.clientHint,
      createdOn: dayStamp(session.createdAt),
      lastSeenOn: dayStamp(session.lastSeenAt ?? session.createdAt),
    }));
}
