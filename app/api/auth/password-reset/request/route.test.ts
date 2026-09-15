import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession, enableTrustedProxyHeaders, uniqueTestIp } from '@/lib/auth/test-helpers';
import type { PasswordResetTokenEntity } from '@/lib/db/schemas';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

function requestReset(body: unknown, ip = uniqueTestIp()) {
  return new NextRequest('http://localhost/api/auth/password-reset/request', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  });
}

describe.skipIf(!dbAvailable)('POST /api/auth/password-reset/request (issue #286)', () => {
  const previousBase = process.env.APP_BASE_URL;
  const cleanups: Array<() => Promise<void>> = [];
  let restoreProxy: (() => void) | undefined;

  beforeEach(() => {
    restoreProxy = enableTrustedProxyHeaders();
  });

  afterEach(async () => {
    restoreProxy?.();
    if (previousBase === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = previousBase;
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('rejects a missing email', async () => {
    const response = await POST(requestReset({}));
    expect(response.status).toBe(400);
  });

  it('returns a generic success for an unknown address and does not leak a reset URL', async () => {
    const response = await POST(requestReset({ email: `unknown-${randomBytes(4).toString('hex')}@example.com` }));
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; resetUrl?: string };
    expect(body.success).toBe(true);
    expect(body.resetUrl).toBeUndefined();
  });

  it('issues a token for an activated account and hides unclaimed profiles', async () => {
    const claimed = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    const unclaimed = await createTestUserAndSession(
      'dirigeant',
      { claimedAt: null, email: `profil-${randomBytes(4).toString('hex')}@sans-acces.local` },
      ['encadrant'],
    );
    cleanups.push(claimed.cleanup, unclaimed.cleanup, async () => {
      const db = await getDb();
      await db.getRepository('PasswordResetToken').delete({ userId: claimed.user.id });
      await db.getRepository('PasswordResetToken').delete({ userId: unclaimed.user.id });
    });

    process.env.APP_BASE_URL = 'http://localhost:3000';
    const claimedResponse = await POST(requestReset({ email: claimed.user.email }));
    expect(claimedResponse.status).toBe(200);
    const claimedBody = await claimedResponse.json() as { success: boolean; resetUrl?: string };
    expect(claimedBody.success).toBe(true);
    expect(claimedBody.resetUrl).toMatch(/\/reinitialiser\/[a-f0-9]{64}$/);

    const db = await getDb();
    const claimedTokens = await db.getRepository<PasswordResetTokenEntity>('PasswordResetToken').findBy({
      userId: claimed.user.id,
    });
    expect(claimedTokens).toHaveLength(1);

    const unclaimedResponse = await POST(requestReset({ email: unclaimed.user.email }));
    expect(unclaimedResponse.status).toBe(200);
    const unclaimedBody = await unclaimedResponse.json() as { success: boolean; resetUrl?: string };
    expect(unclaimedBody.success).toBe(true);
    expect(unclaimedBody.resetUrl).toBeUndefined();
    const unclaimedTokens = await db.getRepository<PasswordResetTokenEntity>('PasswordResetToken').findBy({
      userId: unclaimed.user.id,
    });
    expect(unclaimedTokens).toHaveLength(0);
  });

  it('never builds the reset URL from a forged Host header (issue #32)', async () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';
    const claimed = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    cleanups.push(claimed.cleanup, async () => {
      const db = await getDb();
      await db.getRepository('PasswordResetToken').delete({ userId: claimed.user.id });
    });

    const response = await POST(new NextRequest('http://evil.example/api/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ email: claimed.user.email }),
      headers: {
        'Content-Type': 'application/json',
        host: 'evil.example',
        'x-forwarded-host': 'evil.example',
        'x-forwarded-for': randomBytes(8).toString('hex'),
      },
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { resetUrl?: string };
    expect(body.resetUrl).toMatch(/^http:\/\/localhost:3000\/reinitialiser\/[a-f0-9]{64}$/);
    expect(body.resetUrl).not.toContain('evil.example');
  });
});

describe.skipIf(!dbAvailable)('POST /api/auth/password-reset/request — limitation de débit (issue #381)', () => {
  const cleanupIps: string[] = [];

  afterEach(async () => {
    const db = await getDb();
    for (const ip of cleanupIps.splice(0)) {
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`password-reset-request:ip:${hashBucketComponent(ip)}`]);
    }
  });

  it('renvoie 429 après 5 demandes depuis la même IP', async () => {
    const ip = randomBytes(8).toString('hex');
    cleanupIps.push(ip);

    for (let i = 0; i < 5; i += 1) {
      const response = await POST(requestReset({
        email: `reset-rate-${i}-${randomBytes(4).toString('hex')}@example.com`,
      }, ip));
      expect(response.status).toBe(200);
    }

    const blocked = await POST(requestReset({
      email: `reset-rate-blocked-${randomBytes(4).toString('hex')}@example.com`,
    }, ip));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
    const body = await blocked.json() as { error: string };
    expect(body.error).toBe('Trop de requêtes. Réessayez plus tard.');
  });
});
