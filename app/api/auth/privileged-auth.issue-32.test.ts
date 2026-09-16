import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession, enableTrustedProxyHeaders, uniqueTestIp } from '@/lib/auth/test-helpers';
import { POST as confirmReset } from '@/app/api/auth/password-reset/confirm/route';
import { POST as requestReset } from '@/app/api/auth/password-reset/request/route';
import type { PasswordResetTokenEntity } from '@/lib/db/schemas';

const dbAvailable = await isDbAvailable();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe.skipIf(!dbAvailable)('Reset / invitations — absence de fuite et replay (issue #32)', () => {
  const previousWebhook = process.env.PASSWORD_RESET_WEBHOOK_URL;
  const cleanups: Array<() => Promise<void>> = [];
  let restoreProxy: (() => void) | undefined;

  beforeEach(() => {
    restoreProxy = enableTrustedProxyHeaders();
  });

  afterEach(async () => {
    restoreProxy?.();
    vi.unstubAllEnvs();
    if (previousWebhook === undefined) delete process.env.PASSWORD_RESET_WEBHOOK_URL;
    else process.env.PASSWORD_RESET_WEBHOOK_URL = previousWebhook;
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('ne met jamais le jeton brut dans un webhook, un log structuré ou une réponse générique', async () => {
    const account = await createTestUserAndSession('dirigeant');
    cleanups.push(account.cleanup, async () => {
      const db = await getDb();
      await db.getRepository('PasswordResetToken').delete({ userId: account.user.id });
    });

    // SMTP off + NODE_ENV=test exposerait `resetUrl` en repli local. La garantie
    // issue #32/#30 porte sur la prod : pas de webhook, pas de secret dans le JSON.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_BASE_URL', 'https://app.example.com');
    const payloads: unknown[] = [];
    process.env.PASSWORD_RESET_WEBHOOK_URL = 'http://127.0.0.1:9/never-used';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      payloads.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
      const unknown = await requestReset(new NextRequest('http://localhost/api/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ email: `nobody-${randomBytes(4).toString('hex')}@example.com` }),
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': uniqueTestIp() },
      }));
      const unknownBody = await unknown.json() as { resetUrl?: string; success: boolean };
      expect(unknownBody.success).toBe(true);
      expect(unknownBody.resetUrl).toBeUndefined();

      const known = await requestReset(new NextRequest('http://localhost/api/auth/password-reset/request', {
        method: 'POST',
        body: JSON.stringify({ email: account.user.email }),
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': uniqueTestIp() },
      }));
      expect(known.status).toBe(200);
      const knownBody = await known.json() as { resetUrl?: string };
      expect(knownBody.resetUrl).toBeUndefined();

      expect(payloads).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('consomme un jeton de reset une seule fois', async () => {
    const account = await createTestUserAndSession('dirigeant');
    cleanups.push(account.cleanup);
    const db = await getDb();
    const rawToken = randomBytes(32).toString('hex');
    await db.getRepository<PasswordResetTokenEntity>('PasswordResetToken').save({
      tokenHash: hashToken(rawToken),
      userId: account.user.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      usedAt: null,
    });
    cleanups.push(async () => {
      await db.getRepository('PasswordResetToken').delete({ tokenHash: hashToken(rawToken) });
    });

    const first = await confirmReset(new NextRequest('http://localhost/api/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, newPassword: 'une longue phrase de passe' }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(first.status).toBe(200);
    const second = await confirmReset(new NextRequest('http://localhost/api/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: rawToken, newPassword: 'une autre phrase de passe' }),
      headers: { 'Content-Type': 'application/json' },
    }));
    expect(second.status).toBe(410);
  });
});
