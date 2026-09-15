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

describe.skipIf(!dbAvailable)('GET /api/planning/ical-link (issue #382)', () => {
  it('renvoie l’URL iCal pour la session courante sans exposer le token dans /api/auth/me', async () => {
    const { token, user, cleanup } = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    try {
      const response = await GET(icalLinkRequest(token));
      expect(response.status).toBe(200);
      const body = await response.json() as { feedUrl: string };
      expect(body.feedUrl).toMatch(new RegExp(`/api/ical/${user.icalToken}$`));
      expect(body).not.toHaveProperty('icalToken');
    } finally {
      await cleanup();
    }
  });

  it('refuse l’accès sans session', async () => {
    const response = await GET(icalLinkRequest());
    expect(response.status).toBe(401);
  });

  it('ne permet pas d’obtenir le lien d’un autre utilisateur', async () => {
    const userA = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    const userB = await createTestUserAndSession('dirigeant', {}, ['encadrant']);
    try {
      const response = await GET(icalLinkRequest(userA.token));
      expect(response.status).toBe(200);
      const body = await response.json() as { feedUrl: string };
      expect(body.feedUrl).toContain(`/api/ical/${userA.user.icalToken}`);
      expect(body.feedUrl).not.toContain(userB.user.icalToken);
    } finally {
      await userA.cleanup();
      await userB.cleanup();
    }
  });
});
