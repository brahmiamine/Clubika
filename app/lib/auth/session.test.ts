import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { ClubTenantEntity, UserEntity } from '@/lib/db/schemas';
import { hashPassword } from './password';
import {
  createSession,
  getSessionUser,
  listPublicSessionsForUser,
  onSessionRevocation,
  revokeOtherSessionsForUser,
  revokeSession,
  revokeAllSessionsForUser,
  type SessionRevocationEvent,
} from './session';
import { getClubSessionAuthenticatedAt, touchClubSessionAuth } from './recent-auth';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('session (integration)', () => {
  let userId: number;

  beforeAll(async () => {
    const db = await getDb();
    const userRepo = db.getRepository<UserEntity>('User');
    const user = await userRepo.save({
      email: `session-test-${Date.now()}@example.com`,
      passwordHash: await hashPassword('irrelevant-password'),
      nom: 'Session Test User',
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      personLinks: [],
      icalToken: `ical-${Date.now()}`,
    });
    userId = user.id;
  });

  beforeEach(async () => {
    const db = await getDb();
    await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :userId', { userId }).execute();
  });

  afterAll(async () => {
    const db = await getDb();
    await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :userId', { userId }).execute();
    await db.getRepository('User').delete({ id: userId });
  });

  it('creates a session and resolves it back to the user', async () => {
    const { token } = await createSession(userId);
    const sessionUser = await getSessionUser(token);
    expect(sessionUser?.id).toBe(userId);
  });

  it('relit une session existante avec le rôle d’accès et les fonctions (issue #209)', async () => {
    const db = await getDb();
    const userRepo = db.getRepository<UserEntity>('User');
    // Une session est un simple couple token/userId : celles ouvertes avant la
    // séparation restent valides et sont relues via le nouveau modèle, sans
    // révocation — y compris quand le compte change de rôle ou de fonctions.
    const { token } = await createSession(userId);
    expect(await getSessionUser(token)).toMatchObject({
      id: userId,
      accessRole: 'admin',
      planningFunctions: [],
    });

    await userRepo.update({ id: userId }, {
      accessRole: 'dirigeant',
      planningFunctions: ['arbitre_club', 'encadrant', 'accompagnateur'],
    });
    try {
      // Le même jeton reste valide et expose désormais les trois fonctions cumulées.
      expect(await getSessionUser(token)).toMatchObject({
        id: userId,
        accessRole: 'dirigeant',
        planningFunctions: ['arbitre_club', 'encadrant', 'accompagnateur'],
      });
    } finally {
      await userRepo.update({ id: userId }, { accessRole: 'admin', planningFunctions: [] });
    }
  });

  it('does not store the raw token in the database (issue #29)', async () => {
    const { token, id } = await createSession(userId);
    const db = await getDb();
    const row = await db.getRepository('UserSession').findOneBy({ id });
    expect(row).toBeTruthy();
    expect(row?.id).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(await getSessionUser(token)).not.toBeNull();
    expect(await getSessionUser(row?.id)).toBeNull();
    expect(await getSessionUser(row?.tokenHash)).toBeNull();
  });

  it('reads authenticatedAt from the hashed cookie token (issue #32 + #29)', async () => {
    const { token, id } = await createSession(userId);
    const authenticatedAt = await getClubSessionAuthenticatedAt(token);
    expect(authenticatedAt).toBeInstanceOf(Date);
    expect(await getClubSessionAuthenticatedAt(id)).toBeNull();
    await touchClubSessionAuth(token);
    const afterTouch = await getClubSessionAuthenticatedAt(token);
    expect(afterTouch).toBeInstanceOf(Date);
    expect(afterTouch!.getTime()).toBeGreaterThanOrEqual(authenticatedAt!.getTime());
  });

  it('expires a session after its idle TTL (issue #29)', async () => {
    const { token, id } = await createSession(userId);
    const db = await getDb();
    await db.getRepository('UserSession').update({ id }, {
      lastSeenAt: new Date(Date.now() - 5_000),
      idleTtlSeconds: 1,
    });
    expect(await getSessionUser(token)).toBeNull();
  });

  it('expires a session after its absolute TTL even if idle is recent (issue #29)', async () => {
    const { token, id } = await createSession(userId);
    const db = await getDb();
    await db.getRepository('UserSession').update({ id }, {
      createdAt: new Date(Date.now() - 10_000),
      lastSeenAt: new Date(),
      absoluteTtlSeconds: 1,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    expect(await getSessionUser(token)).toBeNull();
  });

  it('lists coarse session metadata without network hints (issue #29)', async () => {
    const { token } = await createSession(userId, {
      userAgent: 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36',
      ipAddress: '203.0.113.44',
    });
    const sessions = await listPublicSessionsForUser(userId, token);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);
    expect(sessions[0]?.clientHint).toBe('Chrome');
    expect(JSON.stringify(sessions)).not.toContain('203.0.113');
  });

  it('revokes other sessions while keeping the current one (issue #29)', async () => {
    const first = await createSession(userId);
    const second = await createSession(userId);
    const events: SessionRevocationEvent[] = [];
    const unsubscribe = onSessionRevocation((event) => events.push(event));
    try {
      await revokeOtherSessionsForUser(userId, second.token);
      expect(await getSessionUser(first.token)).toBeNull();
      expect(await getSessionUser(second.token)).not.toBeNull();
      expect(events.some((event) => event.userId === userId && event.exceptSessionId === second.id)).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it('returns null for a revoked session', async () => {
    const { token } = await createSession(userId);
    const events: SessionRevocationEvent[] = [];
    const unsubscribe = onSessionRevocation((event) => events.push(event));
    try {
      await revokeSession(token);
      const sessionUser = await getSessionUser(token);
      expect(sessionUser).toBeNull();
      expect(events).toContainEqual({ sessionToken: token, sessionId: expect.any(String), userId });
    } finally {
      unsubscribe();
    }
  });

  it('returns null after revokeAllSessionsForUser', async () => {
    const { token } = await createSession(userId);
    await revokeAllSessionsForUser(userId);
    const sessionUser = await getSessionUser(token);
    expect(sessionUser).toBeNull();
  });

  it('returns null for a malformed token', async () => {
    const sessionUser = await getSessionUser('not-a-real-token');
    expect(sessionUser).toBeNull();
  });

  it('rejects an existing session when its club is inactive (issue #88)', async () => {
    const db = await getDb();
    const clubId = `inactive-session-${Date.now()}`;
    const tenantRepo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const userRepo = db.getRepository<UserEntity>('User');
    const user = await userRepo.findOneBy({ id: userId });
    if (!user) throw new Error('Utilisateur de test introuvable');
    const previousClubId = user.clubId;

    await tenantRepo.save({ id: clubId, name: 'Inactive Session Club', active: true });
    await userRepo.update({ id: userId }, { clubId });
    const { token } = await createSession(userId);

    try {
      expect((await getSessionUser(token))?.id).toBe(userId);
      await tenantRepo.update({ id: clubId }, { active: false });
      expect(await getSessionUser(token)).toBeNull();
    } finally {
      await userRepo.update({ id: userId }, { clubId: previousClubId });
      await tenantRepo.delete({ id: clubId });
    }
  });
});
