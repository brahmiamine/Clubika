import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { GET } from './route';

const dbAvailable = await isDbAvailable();

function icalLinkRequest(token?: string) {
  return new NextRequest('http://localhost/api/planning/ical-link', {
    headers: token ? { cookie: `session_token=${token}` } : {},
  });
}

describe.skipIf(!dbAvailable)('GET /api/planning/ical-link (issue #382, durci par #13)', () => {
  it('renvoie la date de création sans exposer le jeton ni son empreinte', async () => {
    const { token, user, cleanup } = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    try {
      const response = await GET(icalLinkRequest(token));
      expect(response.status).toBe(200);
      const body = await response.json() as { hasToken: boolean; createdAt: string | null };
      expect(body.hasToken).toBe(true);
      expect(body.createdAt).toBeTruthy();
      expect(body).not.toHaveProperty('feedUrl');
      expect(body).not.toHaveProperty('icalToken');
      expect(body).not.toHaveProperty('icalTokenHash');
      expect(JSON.stringify(body)).not.toContain(user.icalToken);
    } finally {
      await cleanup();
    }
  });

  it('refuse l’accès sans session', async () => {
    const response = await GET(icalLinkRequest());
    expect(response.status).toBe(401);
  });

  it('ne renvoie que le statut du compte courant, jamais celui d’un autre utilisateur', async () => {
    const userA = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    const userB = await createTestUserAndSession('dirigeant', {}, ['encadrant']);
    try {
      const response = await GET(icalLinkRequest(userA.token));
      expect(response.status).toBe(200);
      const body = await response.json() as { hasToken: boolean };
      expect(body.hasToken).toBe(true);
      expect(JSON.stringify(body)).not.toContain(userB.user.icalToken);
    } finally {
      await userA.cleanup();
      await userB.cleanup();
    }
  });
});
