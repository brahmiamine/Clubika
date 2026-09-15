import { logError } from '@/lib/observability/log';
import { randomUUID } from 'node:crypto';
import { In, IsNull } from 'typeorm';
import { getDb } from '@/lib/db';
import { UserEntity, UserSessionEntity } from '@/lib/db/schemas';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import {
  normalizeAccessRole,
  normalizePlanningFunctions,
  type ClubAccessRole,
  type PlanningFunction,
} from './roles';
import type { OfficielIndisponibilite } from '@/lib/utils/officiel-availability';
import { coarseClientHint, dayStamp, networkHint } from './session-meta';
import {
  generateSessionToken,
  hashSessionToken,
  isPlausibleSessionToken,
  sessionTokenHashCandidates,
  sessionTokenHashesEqual,
} from './session-token';
import { sessionAudienceForAccessRole, sessionTtlSeconds } from './session-ttl';

export interface SessionRevocationEvent {
  sessionToken?: string;
  sessionId?: string;
  exceptSessionId?: string;
  userId: number;
}

type SessionRevocationListener = (event: SessionRevocationEvent) => void;

declare global {
  var __clubikaSessionRevocationListeners: Set<SessionRevocationListener> | undefined;
}

function sessionRevocationListeners(): Set<SessionRevocationListener> {
  globalThis.__clubikaSessionRevocationListeners ??= new Set();
  return globalThis.__clubikaSessionRevocationListeners;
}

function publishSessionRevocation(event: SessionRevocationEvent): void {
  for (const listener of sessionRevocationListeners()) {
    try {
      listener(event);
    } catch {
      logError('app.unhandled', 'Session revocation listener failed');
    }
  }
}

export function onSessionRevocation(listener: SessionRevocationListener): () => void {
  sessionRevocationListeners().add(listener);
  return () => {
    sessionRevocationListeners().delete(listener);
  };
}

export type NotifyChannel = 'push' | 'email' | 'both';

export function isNotifyChannel(value: unknown): value is NotifyChannel {
  return value === 'push' || value === 'email' || value === 'both';
}

export { SESSION_COOKIE_NAME } from './constants';

const LAST_SEEN_TOUCH_MS = 60_000;

export interface SessionUser {
  id: number;
  clubId: string;
  email: string;
  nom: string;
  /** Rôle d'accès au club : seul `admin` autorise l'écriture (issue #209). */
  accessRole: ClubAccessRole;
  /** Fonctions opérationnelles cumulables, sans effet sur les permissions. */
  planningFunctions: PlanningFunction[];
  telephone: string | null;
  indisponibilites: OfficielIndisponibilite[] | null;
  active: boolean;
  notifyChannel: NotifyChannel;
}

export interface PublicSessionInfo {
  id: string;
  current: boolean;
  clientHint: string | null;
  createdOn: string | null;
  lastSeenOn: string | null;
}

export interface ResolvedClubSession {
  user: SessionUser;
  session: UserSessionEntity;
}

function toSessionUser(user: UserEntity): SessionUser {
  return {
    id: user.id,
    clubId: user.clubId || process.env.APP_CLUB_ID || 'afp',
    email: user.email,
    nom: user.nom,
    accessRole: normalizeAccessRole(user.accessRole),
    planningFunctions: normalizePlanningFunctions(user.planningFunctions),
    telephone: user.telephone ?? null,
    indisponibilites: user.indisponibilites ?? null,
    active: user.active,
    notifyChannel: isNotifyChannel(user.notifyChannel) ? user.notifyChannel : 'push',
  };
}

function sessionIsExpired(session: UserSessionEntity, now = Date.now()): boolean {
  const lastSeen = new Date(session.lastSeenAt ?? session.createdAt).getTime();
  const created = new Date(session.createdAt).getTime();
  const idleDeadline = lastSeen + session.idleTtlSeconds * 1000;
  const absoluteDeadline = Math.min(
    new Date(session.expiresAt).getTime(),
    created + session.absoluteTtlSeconds * 1000,
  );
  return now >= idleDeadline || now >= absoluteDeadline;
}

async function findSessionByToken(token: string): Promise<UserSessionEntity | null> {
  const db = await getDb();
  const repo = db.getRepository<UserSessionEntity>('UserSession');
  const candidates = sessionTokenHashCandidates(token);
  const sessions = await repo.find({ where: { tokenHash: In(candidates) } });
  for (const session of sessions) {
    if (candidates.some((digest) => sessionTokenHashesEqual(session.tokenHash, digest))) {
      return session;
    }
  }
  return null;
}

export async function createSession(
  userId: number,
  meta?: { userAgent?: string | null; ipAddress?: string | null },
): Promise<{ token: string; expiresAt: Date; id: string }> {
  const db = await getDb();
  const user = await db.getRepository<UserEntity>('User').findOneBy({ id: userId });
  const ttl = sessionTtlSeconds(sessionAudienceForAccessRole(user?.accessRole));
  const repo = db.getRepository<UserSessionEntity>('UserSession');

  const token = generateSessionToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttl.absolute * 1000);

  const saved = await repo.save({
    id: randomUUID(),
    tokenHash: hashSessionToken(token),
    userId,
    lastSeenAt: now,
    expiresAt,
    idleTtlSeconds: ttl.idle,
    absoluteTtlSeconds: ttl.absolute,
    revokedAt: null,
    clientHint: coarseClientHint(meta?.userAgent),
    networkHint: networkHint(meta?.ipAddress),
    authenticatedAt: new Date(),
  });

  return { token, expiresAt, id: saved.id };
}

export async function resolveClubSession(token: string | undefined | null): Promise<ResolvedClubSession | null> {
  if (!isPlausibleSessionToken(token)) {
    return null;
  }

  const session = await findSessionByToken(token);
  if (!session || session.revokedAt !== null) {
    return null;
  }
  if (sessionIsExpired(session)) {
    await revokeSessionRecord(session, token);
    return null;
  }

  const db = await getDb();
  const user = await db.getRepository<UserEntity>('User').findOneBy({ id: session.userId });
  if (!user || !user.active) {
    return null;
  }

  const clubId = user.clubId || process.env.APP_CLUB_ID || 'afp';
  if (!(await isClubTenantActive(db, clubId))) {
    return null;
  }

  const lastSeenMs = new Date(session.lastSeenAt ?? session.createdAt).getTime();
  if (Date.now() - lastSeenMs >= LAST_SEEN_TOUCH_MS) {
    const touched = new Date();
    session.lastSeenAt = touched;
    await db.getRepository<UserSessionEntity>('UserSession').update({ id: session.id }, { lastSeenAt: touched });
  }

  return { user: toSessionUser(user), session };
}

export async function getSessionUser(token: string | undefined | null): Promise<SessionUser | null> {
  return (await resolveClubSession(token))?.user ?? null;
}

async function revokeSessionRecord(session: UserSessionEntity, token?: string): Promise<void> {
  if (session.revokedAt !== null) return;
  const db = await getDb();
  session.revokedAt = new Date();
  await db.getRepository<UserSessionEntity>('UserSession').save(session);
  publishSessionRevocation({
    sessionToken: token,
    sessionId: session.id,
    userId: session.userId,
  });
}

export async function revokeSession(token: string | undefined | null): Promise<void> {
  if (!isPlausibleSessionToken(token)) {
    return;
  }
  const session = await findSessionByToken(token);
  if (session) {
    await revokeSessionRecord(session, token);
  }
}

export async function revokeSessionById(userId: number, sessionId: string): Promise<boolean> {
  const db = await getDb();
  const repo = db.getRepository<UserSessionEntity>('UserSession');
  const session = await repo.findOneBy({ id: sessionId, userId });
  if (!session || session.revokedAt !== null) return false;
  await revokeSessionRecord(session);
  return true;
}

export async function revokeAllSessionsForUser(userId: number): Promise<void> {
  const db = await getDb();
  const repo = db.getRepository<UserSessionEntity>('UserSession');
  await repo
    .createQueryBuilder()
    .update()
    .set({ revokedAt: new Date() })
    .where('userId = :userId', { userId })
    .andWhere('revokedAt IS NULL')
    .execute();
  publishSessionRevocation({ userId });
}

export async function revokeOtherSessionsForUser(userId: number, currentToken: string): Promise<number> {
  const current = await findSessionByToken(currentToken);
  const db = await getDb();
  const repo = db.getRepository<UserSessionEntity>('UserSession');
  const result = await repo
    .createQueryBuilder()
    .update()
    .set({ revokedAt: new Date() })
    .where('userId = :userId', { userId })
    .andWhere('revokedAt IS NULL')
    .andWhere(current ? 'id != :currentId' : '1=1', current ? { currentId: current.id } : {})
    .execute();
  publishSessionRevocation({ userId, exceptSessionId: current?.id });
  return Number(result.affected ?? 0);
}

/** Révoque immédiatement toutes les sessions des utilisateurs d'un club. */
export async function revokeAllSessionsForClub(clubId: string): Promise<void> {
  const db = await getDb();
  const users = await db.getRepository<UserEntity>('User').find({ where: { clubId }, select: ['id'] });
  if (users.length === 0) return;

  const userIds = users.map((user) => user.id);
  await db.getRepository<UserSessionEntity>('UserSession')
    .createQueryBuilder()
    .update()
    .set({ revokedAt: new Date() })
    .where('userId IN (:...userIds)', { userIds })
    .andWhere('revokedAt IS NULL')
    .execute();

  for (const userId of userIds) publishSessionRevocation({ userId });
}

export async function listPublicSessionsForUser(
  userId: number,
  currentToken?: string | null,
): Promise<PublicSessionInfo[]> {
  const db = await getDb();
  const repo = db.getRepository<UserSessionEntity>('UserSession');
  const sessions = await repo.find({
    where: { userId, revokedAt: IsNull() },
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
