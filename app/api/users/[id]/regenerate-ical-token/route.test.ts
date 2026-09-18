import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession, uniqueTestIp } from '@/lib/auth/test-helpers';
import { GET as getIcalFeed } from '@/app/api/ical/[token]/route';
import { POST, DELETE } from './route';

const dbAvailable = await isDbAvailable();

function actionRequest(method: 'POST' | 'DELETE', id: number, token: string) {
  return new NextRequest(`http://localhost/api/users/${id}/regenerate-ical-token`, {
    method,
    headers: { cookie: `session_token=${token}` },
  });
}

function feedRequest(icalToken: string) {
  return new NextRequest(`http://localhost/api/ical/${icalToken}`, {
    headers: { 'x-forwarded-for': uniqueTestIp() },
  });
}

describe.skipIf(!dbAvailable)('POST/DELETE /api/users/[id]/regenerate-ical-token (issue #13)', () => {
  it('régénère le jeton, invalide immédiatement l’ancien et ne le restitue plus jamais (rotation)', async () => {
    const { user, token, cleanup } = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    const oldIcalToken = user.icalToken;

    try {
      const before = await getIcalFeed(feedRequest(oldIcalToken) as never, { params: { token: oldIcalToken } });
      expect(before.status).toBe(200);

      const response = await POST(actionRequest('POST', user.id, token), { params: { id: String(user.id) } });
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; feedUrl: string; createdAt: string };
      expect(body.success).toBe(true);
      expect(body.createdAt).toBeTruthy();
      const newIcalToken = body.feedUrl.split('/api/ical/')[1];
      expect(newIcalToken).toBeTruthy();
      expect(newIcalToken).not.toBe(oldIcalToken);

      // Ancien jeton (déjà distribué à une appli calendrier) : révoqué (issue #13),
      // même message d'erreur qu'un jeton qui n'a jamais existé.
      const afterOld = await getIcalFeed(feedRequest(oldIcalToken) as never, { params: { token: oldIcalToken } });
      expect(afterOld.status).toBe(404);

      const afterNew = await getIcalFeed(feedRequest(newIcalToken!) as never, { params: { token: newIcalToken! } });
      expect(afterNew.status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('révoque le flux sans en émettre un nouveau : l’ancien lien cesse de fonctionner immédiatement', async () => {
    const { user, token, cleanup } = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    const icalToken = user.icalToken;

    try {
      const before = await getIcalFeed(feedRequest(icalToken) as never, { params: { token: icalToken } });
      expect(before.status).toBe(200);

      const response = await DELETE(actionRequest('DELETE', user.id, token), { params: { id: String(user.id) } });
      expect(response.status).toBe(200);
      const body = await response.json() as { success: boolean; hasToken: boolean };
      expect(body).toEqual({ success: true, hasToken: false, createdAt: null });

      const after = await getIcalFeed(feedRequest(icalToken) as never, { params: { token: icalToken } });
      expect(after.status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  it('refuse à un dirigeant de régénérer ou révoquer le jeton d’un autre utilisateur du même club', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const actor = await createTestUserAndSession('dirigeant', { clubId }, ['arbitre_club']);
    const other = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    const otherIcalToken = other.user.icalToken;

    try {
      const regenResponse = await POST(actionRequest('POST', other.user.id, actor.token), { params: { id: String(other.user.id) } });
      expect(regenResponse.status).toBe(403);

      const revokeResponse = await DELETE(actionRequest('DELETE', other.user.id, actor.token), { params: { id: String(other.user.id) } });
      expect(revokeResponse.status).toBe(403);

      // Le jeton de l'autre utilisateur n'a pas bougé : ni régénéré, ni révoqué.
      const feed = await getIcalFeed(feedRequest(otherIcalToken) as never, { params: { token: otherIcalToken } });
      expect(feed.status).toBe(200);
    } finally {
      await actor.cleanup();
      await other.cleanup();
    }
  });

  it('isole les clubs : un admin ne peut pas régénérer le jeton d’un utilisateur d’un autre club (404)', async () => {
    const clubA = `test-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-b-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId: clubA });
    const userB = await createTestUserAndSession('dirigeant', { clubId: clubB }, ['arbitre_club']);
    const userBIcalToken = userB.user.icalToken;

    try {
      const response = await POST(actionRequest('POST', userB.user.id, adminA.token), { params: { id: String(userB.user.id) } });
      // `findOneBy({ id, clubId: auth.user.clubId })` ne trouve rien hors du club de
      // l'appelant : même comportement qu'un identifiant inexistant, pas de fuite
      // d'information sur l'existence d'un compte dans un autre club.
      expect(response.status).toBe(404);

      const feed = await getIcalFeed(feedRequest(userBIcalToken) as never, { params: { token: userBIcalToken } });
      expect(feed.status).toBe(200);
    } finally {
      await adminA.cleanup();
      await userB.cleanup();
    }
  });
});
