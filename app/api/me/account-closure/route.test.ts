import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { GET, POST } from './route';

const dbAvailable = await isDbAvailable();

function request(token: string, body?: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/me/account-closure', {
    method: body ? 'POST' : 'GET',
    headers: {
      cookie: `session_token=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe.skipIf(!dbAvailable)('GET/POST /api/me/account-closure (issue #11)', () => {
  it('refuse la fermeture du dernier administrateur et accepte un dirigeant', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const dirigeant = await createTestUserAndSession('dirigeant', { clubId, nom: `À fermer ${randomBytes(3).toString('hex')}` });

    try {
      const lastAdmin = await POST(request(admin.token, { confirm: true }));
      expect(lastAdmin.status).toBe(400);
      const lastBody = await lastAdmin.json() as { error: string };
      expect(lastBody.error).toMatch(/dernier administrateur/i);

      const preview = await GET(request(dirigeant.token));
      expect(preview.status).toBe(200);
      const previewBody = await preview.json() as { preview: { displayName: string } };
      expect(previewBody.preview.displayName).toBe('Utilisateur supprimé');

      const requested = await POST(request(dirigeant.token, {}));
      expect(requested.status).toBe(200);
      const requestedBody = await requested.json() as { requested: boolean };
      expect(requestedBody.requested).toBe(true);

      const closed = await POST(request(dirigeant.token, { confirm: true }));
      expect(closed.status).toBe(200);
      const closedBody = await closed.json() as { closure: { alreadyClosed: boolean; preview: { retained: unknown[] } } };
      expect(closedBody.closure.alreadyClosed).toBe(false);
      expect(JSON.stringify(closedBody)).not.toContain(dirigeant.user.email);

      const db = await getDb();
      const stub = await db.getRepository('User').findOneBy({ id: dirigeant.user.id });
      expect(stub?.nom).toBe('Utilisateur supprimé');
      expect(stub?.active).toBe(false);
    } finally {
      const db = await getDb();
      await db.query('DELETE FROM account_closures WHERE user_id IN (?, ?)', [admin.user.id, dirigeant.user.id]);
      await admin.cleanup();
      await dirigeant.cleanup();
    }
  });
});
