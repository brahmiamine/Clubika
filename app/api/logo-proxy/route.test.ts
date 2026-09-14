import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { GET } from './route';

const dbAvailable = await isDbAvailable();

function proxyRequest(url: string, sessionToken?: string) {
  const target = `http://localhost/api/logo-proxy?url=${encodeURIComponent(url)}`;
  return new NextRequest(target, {
    headers: sessionToken ? { cookie: `${SESSION_COOKIE_NAME}=${sessionToken}` } : undefined,
  });
}

// Auth vérifiée contre une session réelle en base (issue #272) : `proxy.ts` ne
// valide que la forme du cookie (64 hex), jamais son authenticité — c'est cette
// route elle-même qui doit désormais appeler `requireAuth`. Les tests de logique
// SSRF pure (sans dépendance DB) vivent dans route.ssrf.test.ts.
describe.skipIf(!dbAvailable)('GET /api/logo-proxy — authentification (issue #272)', () => {
  it('refuse une requête sans cookie de session', async () => {
    const response = await GET(proxyRequest('https://example.com/logo.png'));
    expect(response.status).toBe(401);
  });

  it("refuse un cookie de forme plausible (64 hex) qui ne correspond à aucune session réelle", async () => {
    const fakeButWellFormed = randomBytes(32).toString('hex');
    const response = await GET(proxyRequest('https://example.com/logo.png', fakeButWellFormed));
    expect(response.status).toBe(401);
  });

  it('laisse passer une session authentique jusqu\'à la logique SSRF (rejet réseau attendu ici)', async () => {
    const account = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    try {
      // Hôte bloqué : la réponse 400 prouve qu'on a dépassé requireAuth (sinon 401).
      const response = await GET(proxyRequest('http://127.0.0.1/logo.png', account.token));
      // 400 = SSRF / hôte non allowlisté ; 409 = proxy kill-switché. Les deux prouvent l’auth.
      expect([400, 409]).toContain(response.status);
    } finally {
      await account.cleanup();
    }
  });
});
