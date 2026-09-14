import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { getSessionUser } from '@/lib/auth/session';
import { hashSessionToken } from '@/lib/auth/session-token';
import { hashExistingSessionTokens } from './hashed-sessions';
import type { UserSessionEntity } from '@/lib/db/schemas';

const dbAvailable = await isDbAvailable();

describe('migration 0025 — base neuve', () => {
  it("ignore le backfill lorsque la table n'existe pas encore", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const result = await hashExistingSessionTokens({ query } as unknown as Awaited<ReturnType<typeof getDb>>);
    expect(result).toEqual({ club: 0, platform: 0 });
  });
});

describe.skipIf(!dbAvailable)('migration 0025 — hashExistingSessionTokens (issue #29)', () => {
  it('remplace un id jeton brut par un UUID et conserve le cookie historique', async () => {
    const db = await getDb();
    const { user, cleanup } = await createTestUserAndSession('dirigeant');
    const rawToken = randomBytes(32).toString('hex');
    const repo = db.getRepository<UserSessionEntity>('UserSession');
    const now = new Date();
    await repo.save({
      id: rawToken,
      tokenHash: 'pending-plaintext',
      userId: user.id,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      idleTtlSeconds: 3600,
      absoluteTtlSeconds: 86400,
      revokedAt: null,
      clientHint: null,
      networkHint: null,
    });

    try {
      const migrated = await hashExistingSessionTokens(db);
      expect(migrated.club).toBeGreaterThanOrEqual(1);
      expect(await repo.findOneBy({ id: rawToken })).toBeNull();
      expect(await getSessionUser(rawToken)).not.toBeNull();
      const stored = await repo.findOneBy({ tokenHash: hashSessionToken(rawToken) });
      expect(stored?.id).not.toBe(rawToken);
      await hashExistingSessionTokens(db);
      expect(await repo.findOneBy({ tokenHash: hashSessionToken(rawToken) })).not.toBeNull();
    } finally {
      await repo.createQueryBuilder().delete().where('userId = :userId', { userId: user.id }).execute();
      await cleanup();
    }
  });
});
