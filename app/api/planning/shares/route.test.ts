import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { GET as PUBLIC_GET } from '@/app/api/public/planning/[token]/route';
import { DELETE, GET, POST } from './route';

const dbAvailable = await isDbAvailable();

function authedRequest(method: string, token: string, url = 'http://localhost/api/planning/shares', body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { cookie: `session_token=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe.skipIf(!dbAvailable)('/api/planning/shares (issue #155)', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await GET(new NextRequest('http://localhost/api/planning/shares'));
    expect(response.status).toBe(401);
  });

  it('rejects an invalid date range', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin');
    try {
      const response = await POST(authedRequest('POST', token, undefined, {
        fromDate: '2026-09-20',
        toDate: '2026-09-10',
      }));
      expect(response.status).toBe(400);
    } finally {
      await cleanup();
    }
  });

  describe('bornes de la durée d’expiration (issue #14)', () => {
    // Marge de tolérance sur le calcul « maintenant + N jours » (exécution du test).
    const TOLERANCE_MS = 60_000;

    function daysFromNow(iso: string): number {
      return (Date.parse(iso) - Date.now()) / (24 * 60 * 60 * 1000);
    }

    it.each([
      ['0', 0, 1],
      ['une valeur négative', -5, 1],
      ['une valeur non numérique', 'pas-un-nombre', 7],
      ['30 jours (nouvelle limite)', 30, 30],
      ['plus de 30 jours', 90, 30],
    ])('clampe expiryDays=%s (%s) vers %i jour(s)', async (_label, rawExpiryDays, expectedDays) => {
      const { token, cleanup } = await createTestUserAndSession('admin');
      let shareId: string | null = null;
      try {
        const response = await POST(authedRequest('POST', token, undefined, { expiryDays: rawExpiryDays }));
        expect(response.status).toBe(200);
        const body = await response.json();
        shareId = body.share.id;
        expect(body.maxExpiryDays).toBe(30);
        const actualDays = daysFromNow(body.share.expiresAt);
        expect(Math.abs(actualDays - expectedDays)).toBeLessThan(TOLERANCE_MS / (24 * 60 * 60 * 1000));
      } finally {
        if (shareId) await DELETE(authedRequest('DELETE', token, `http://localhost/api/planning/shares?id=${shareId}`));
        await cleanup();
      }
    });

    it('n’accepte plus 90 jours comme durée maximale (réduite de 90 à 30 jours)', async () => {
      const { token, cleanup } = await createTestUserAndSession('admin');
      let shareId: string | null = null;
      try {
        const response = await POST(authedRequest('POST', token, undefined, { expiryDays: 90 }));
        const body = await response.json();
        shareId = body.share.id;
        const actualDays = daysFromNow(body.share.expiresAt);
        expect(actualDays).toBeLessThan(31);
        expect(actualDays).toBeGreaterThan(29);
      } finally {
        if (shareId) await DELETE(authedRequest('DELETE', token, `http://localhost/api/planning/shares?id=${shareId}`));
        await cleanup();
      }
    });

    it('expose la durée maximale configurée dans la liste d’administration', async () => {
      const { token, cleanup } = await createTestUserAndSession('admin');
      try {
        const response = await GET(authedRequest('GET', token));
        const body = await response.json();
        expect(body.maxExpiryDays).toBe(30);
      } finally {
        await cleanup();
      }
    });
  });

  it('révoque immédiatement l’accès public après suppression', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin');
    let shareId: string | null = null;
    try {
      const createResponse = await POST(authedRequest('POST', token, undefined, { expiryDays: 3 }));
      const created = await createResponse.json();
      shareId = created.share.id;
      const shareToken = created.share.token as string;

      const beforeRevoke = await PUBLIC_GET(
        new NextRequest(`http://localhost/api/public/planning/${shareToken}`) as never,
        { params: Promise.resolve({ token: shareToken }) },
      );
      expect(beforeRevoke.status).toBe(200);
      // Cache-Control: private, no-store (issue #14) — jamais mis en cache par un
      // intermédiaire ni réutilisé après révocation.
      expect(beforeRevoke.headers.get('Cache-Control')).toContain('private');
      expect(beforeRevoke.headers.get('Cache-Control')).toContain('no-store');

      const deleteResponse = await DELETE(authedRequest('DELETE', token, `http://localhost/api/planning/shares?id=${shareId}`));
      expect(deleteResponse.status).toBe(200);
      shareId = null;

      const afterRevoke = await PUBLIC_GET(
        new NextRequest(`http://localhost/api/public/planning/${shareToken}`) as never,
        { params: Promise.resolve({ token: shareToken }) },
      );
      expect(afterRevoke.status).toBe(404);
    } finally {
      if (shareId) {
        await DELETE(authedRequest('DELETE', token, `http://localhost/api/planning/shares?id=${shareId}`));
      }
      await cleanup();
    }
  });

  it('creates a share token, lists it, then deletes it', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin');
    let shareId: string | null = null;
    try {
      const createResponse = await POST(authedRequest('POST', token, undefined, { expiryDays: 3 }));
      expect(createResponse.status).toBe(200);
      const created = await createResponse.json();
      shareId = created.share.id;
      expect(created.share.path).toMatch(/^\/partage\//);
      expect(typeof created.share.token).toBe('string');
      expect(created.share.token.length).toBeGreaterThan(10);

      const listResponse = await GET(authedRequest('GET', token));
      expect(listResponse.status).toBe(200);
      const list = await listResponse.json();
      expect(list.shares.some((share: { id: string }) => share.id === shareId)).toBe(true);
      // Le token en clair n'est jamais renvoyé une fois le partage créé.
      expect(list.shares.every((share: Record<string, unknown>) => !('token' in share))).toBe(true);

      const deleteResponse = await DELETE(authedRequest('DELETE', token, `http://localhost/api/planning/shares?id=${shareId}`));
      expect(deleteResponse.status).toBe(200);
      shareId = null;

      const finalList = await (await GET(authedRequest('GET', token))).json();
      expect(finalList.shares.some((share: { id: string }) => share.id === created.share.id)).toBe(false);
    } finally {
      if (shareId) {
        await DELETE(authedRequest('DELETE', token, `http://localhost/api/planning/shares?id=${shareId}`));
      }
      await cleanup();
    }
  });
});
