import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { revokeSession } from '@/lib/auth/session';
import { savePlanningRecord } from '@/lib/planning/records';
import { hashShareToken, newShareToken, type PublicShareScope } from '@/lib/planning/public-share';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';
import { proxy } from './proxy';
import { GET as getPublicPlanning } from './app/api/public/planning/[token]/route';

const dbAvailable = await isDbAvailable();

function anonymousRequest(path: string): NextRequest {
  // Aucun cookie de session : reproduit exactement un visiteur strictement anonyme.
  return new NextRequest(new Request(`http://localhost${path}`));
}

describe('proxy — exceptions publiques (issue #211)', () => {
  it("laisse passer un visiteur anonyme sur /droits-sans-compte", async () => {
    const response = await proxy(anonymousRequest('/droits-sans-compte'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
  });

  it("laisse passer un visiteur anonyme sur /partage/<token>", async () => {
    const response = await proxy(anonymousRequest('/partage/un-token-quelconque'));
    // NextResponse.next() ne porte ni redirection ni statut d'erreur.
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
  });

  it('laisse passer un visiteur anonyme sur /exercice-des-droits (issue #22)', async () => {
    const response = await proxy(anonymousRequest('/exercice-des-droits'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
  });

  it.each(['/mentions-legales', '/confidentialite', '/cgu'])(
    'laisse passer un visiteur anonyme sur %s (issue #12)',
    async (path) => {
      const response = await proxy(anonymousRequest(path));
      expect(response.headers.get('location')).toBeNull();
      expect(response.status).toBe(200);
    },
  );

  it('laisse passer un visiteur anonyme sur /api/privacy/exports/<token> (issue #22)', async () => {
    const response = await proxy(anonymousRequest('/api/privacy/exports/un-jeton'));
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
  });

  it('continue de rediriger un visiteur anonyme vers /login sur une page protégée', async () => {
    const response = await proxy(anonymousRequest('/club'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('continue de renvoyer 401 JSON pour une route API protégée sans session', async () => {
    const response = await proxy(anonymousRequest('/api/matches-amicaux'));
    expect(response.status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)('proxy — session révoquée (issue #351)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  function authedRequest(path: string, token: string): NextRequest {
    return new NextRequest(new Request(`http://localhost${path}`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }));
  }

  it('rejette un token révoqué sur une route API protégée avant le handler métier', async () => {
    const session = await createTestUserAndSession('dirigeant');
    cleanups.push(session.cleanup);
    await revokeSession(session.token);

    const response = await proxy(authedRequest('/api/matches-amicaux', session.token));
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe('Non authentifié');
  });

  it('laisse passer une route API publique même avec un token révoqué', async () => {
    const session = await createTestUserAndSession('dirigeant');
    cleanups.push(session.cleanup);
    await revokeSession(session.token);

    const response = await proxy(authedRequest('/api/settings', session.token));
    expect(response.headers.get('location')).toBeNull();
    expect(response.status).toBe(200);
  });
});

describe.skipIf(!dbAvailable)('proxy + route publique — parcours HTTP complet (issue #211)', () => {
  const CLUB_ID = `test-club-${randomBytes(6).toString('hex')}`;
  const cleanupIds: string[] = [];

  afterEach(async () => {
    const db = await getDb();
    for (const id of cleanupIds) {
      await db.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [id, CLUB_ID]);
    }
    cleanupIds.length = 0;
    await db.query('DELETE FROM club_tenants WHERE id = ?', [CLUB_ID]);
  });

  it("un visiteur anonyme franchit le proxy puis obtient le planning partagé via l'API publique", async () => {
    const db = await getDb();
    const publishedId = `published-planning:${CLUB_ID}`;
    cleanupIds.push(publishedId);
    await savePlanningRecord(db, {
      id: publishedId,
      clubId: CLUB_ID,
      kind: 'published-planning',
      payload: {
        schemaVersion: 1,
        publishedAt: new Date().toISOString(),
        publishedByUserId: 0,
        events: [{
          eventId: 'kept',
          eventType: 'entrainement',
          title: 'Entraînement partagé',
          date: '15/09/2026',
          time: '18:00',
          durationMinutes: 90,
          location: 'Terrain A',
          planningStatus: 'published',
          event: { id: 'kept', type: 'entrainement', date: '15/09/2026', time: '18:00', lieu: 'Terrain A', encadrants: [] },
          extras: null,
          assignments: { officiel: [], encadrant: [], accompagnateur: [] },
        } as unknown as PlanningEventSnapshot],
      },
    });

    const token = newShareToken();
    const shareId = `public-share:${randomBytes(8).toString('hex')}`;
    cleanupIds.push(shareId);
    const scope: PublicShareScope = { eventTypes: [], fromDate: null, toDate: null };
    await savePlanningRecord(db, {
      id: shareId,
      clubId: CLUB_ID,
      kind: 'public-share',
      // Colonne indexée dédiée (issue #277) : la résolution par jeton lit désormais
      // `token_hash`, jamais le `payload` en balayant les enregistrements récents.
      tokenHash: hashShareToken(token),
      payload: {
        tokenHash: hashShareToken(token),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        scope,
        createdByUserId: 0,
      },
    });

    // 1) Le vrai gatekeeper : un visiteur sans cookie ne doit pas être redirigé.
    const proxyResponse = await proxy(anonymousRequest(`/api/public/planning/${token}`));
    expect(proxyResponse.headers.get('location')).toBeNull();
    expect(proxyResponse.status).toBe(200);

    // 2) Une fois passé le proxy, le handler sert bien le planning.
    const routeResponse = await getPublicPlanning(
      new Request(`http://localhost/api/public/planning/${token}`) as never,
      { params: Promise.resolve({ token }) },
    );
    expect(routeResponse.status).toBe(200);
    const body = await routeResponse.json();
    expect((body.items as Array<{ title: string }>).map((item) => item.title)).toContain('Entraînement');
  });

  it('un token invalide répond par une erreur explicite, jamais par une redirection de connexion', async () => {
    const proxyResponse = await proxy(anonymousRequest('/api/public/planning/token-invalide'));
    expect(proxyResponse.headers.get('location')).toBeNull();
    expect(proxyResponse.status).toBe(200);

    const routeResponse = await getPublicPlanning(
      new Request('http://localhost/api/public/planning/token-invalide') as never,
      { params: Promise.resolve({ token: 'token-invalide' }) },
    );
    expect(routeResponse.status).not.toBe(307);
    expect([400, 404]).toContain(routeResponse.status);
  });
});

describe('proxy — CSRF (issue #35)', () => {
  function postRequest(path: string, origin?: string, cookie?: string) {
    const headers = new Headers();
    if (origin) headers.set('origin', origin);
    if (cookie) headers.set('cookie', `${SESSION_COOKIE_NAME}=${cookie}`);
    return new NextRequest(new Request(`http://localhost${path}`, { method: 'POST', headers }));
  }

  it('refuse un POST cookie-authenticated cross-site', async () => {
    const response = await proxy(postRequest('/api/auth/login', 'https://evil.example', 'a'.repeat(64)));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Origine non autorisée' });
  });

  it('refuse un POST sans Origin', async () => {
    const response = await proxy(postRequest('/api/auth/login'));
    expect(response.status).toBe(403);
  });

  it('laisse passer un POST same-origin jusqu’au handler', async () => {
    const response = await proxy(postRequest('/api/auth/login', 'http://localhost'));
    expect(response.status).not.toBe(403);
    expect(response.headers.get('location')).toBeNull();
  });

  it('pose une CSP report-only sur les documents', async () => {
    const response = await proxy(anonymousRequest('/login'));
    const csp = response.headers.get('Content-Security-Policy-Report-Only') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('report-uri /api/security/csp-report');
  });
});

