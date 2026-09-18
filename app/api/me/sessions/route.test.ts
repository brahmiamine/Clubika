import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { createSession, getSessionUser } from '@/lib/auth/session';
import { GET } from './route';
import { POST as revokeOthers } from './revoke-others/route';
import { DELETE } from './[id]/route';

const dbAvailable = await isDbAvailable();

function authed(token: string, url: string, method = 'GET') {
  return new NextRequest(url, {
    method,
    headers: { cookie: `session_token=${token}` },
  });
}

describe.skipIf(!dbAvailable)('/api/me/sessions (issue #29)', () => {
  it('lists only the caller sessions and can revoke another device', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const account = await createTestUserAndSession('dirigeant', { clubId });
    const otherClub = await createTestUserAndSession('dirigeant', {
      clubId: `other-${randomBytes(4).toString('hex')}`,
    });
    const extra = await createSession(account.user.id);

    try {
      const listed = await GET(authed(account.token, 'http://localhost/api/me/sessions'));
      expect(listed.status).toBe(200);
      const body = await listed.json() as { sessions: Array<{ id: string; current: boolean }> };
      expect(body.sessions).toHaveLength(2);
      expect(body.sessions.filter((session) => session.current)).toHaveLength(1);
      expect(body.sessions.some((session) => session.id === extra.id)).toBe(true);

      const otherList = await GET(authed(otherClub.token, 'http://localhost/api/me/sessions'));
      const otherBody = await otherList.json() as { sessions: Array<{ id: string }> };
      expect(otherBody.sessions.some((session) => session.id === extra.id)).toBe(false);

      const revoked = await DELETE(
        authed(account.token, `http://localhost/api/me/sessions/${extra.id}`, 'DELETE'),
        { params: { id: extra.id } },
      );
      expect(revoked.status).toBe(200);
      expect(await getSessionUser(extra.token)).toBeNull();
      expect(await getSessionUser(account.token)).not.toBeNull();
    } finally {
      await account.cleanup();
      await otherClub.cleanup();
    }
  });

  it('revokes every other session in one call', async () => {
    const account = await createTestUserAndSession('dirigeant');
    const extra = await createSession(account.user.id);
    try {
      const response = await revokeOthers(authed(account.token, 'http://localhost/api/me/sessions/revoke-others', 'POST'));
      expect(response.status).toBe(200);
      expect(await getSessionUser(extra.token)).toBeNull();
      expect(await getSessionUser(account.token)).not.toBeNull();
    } finally {
      await account.cleanup();
    }
  });

  it('does not let a user revoke another tenant session by id', async () => {
    const clubA = await createTestUserAndSession('dirigeant', { clubId: `a-${randomBytes(4).toString('hex')}` });
    const clubB = await createTestUserAndSession('dirigeant', { clubId: `b-${randomBytes(4).toString('hex')}` });
    try {
      const db = await getDb();
      const foreign = await db.getRepository('UserSession').findOneBy({ userId: clubB.user.id });
      expect(foreign).toBeTruthy();
      const response = await DELETE(
        authed(clubA.token, `http://localhost/api/me/sessions/${foreign!.id}`, 'DELETE'),
        { params: { id: foreign!.id } },
      );
      expect(response.status).toBe(404);
      expect(await getSessionUser(clubB.token)).not.toBeNull();
    } finally {
      await clubA.cleanup();
      await clubB.cleanup();
    }
  });
});
