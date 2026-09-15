import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { GET, PUT } from './route';

const dbAvailable = await isDbAvailable();

function featuresRequest(method: 'GET' | 'PUT', token?: string, body?: unknown) {
  return new NextRequest('http://localhost/api/settings/planning-features', {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      ...(token ? { cookie: `session_token=${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

describe.skipIf(!dbAvailable)('/api/settings/planning-features (issue #286)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('rejects anonymous and non-admin callers', async () => {
    const dirigeant = await createTestUserAndSession('dirigeant', {}, ['arbitre_club']);
    cleanups.push(dirigeant.cleanup);

    expect((await GET(featuresRequest('GET'))).status).toBe(401);
    expect((await GET(featuresRequest('GET', dirigeant.token))).status).toBe(403);
    expect((await PUT(featuresRequest('PUT', dirigeant.token, { features: { scraperSync: false } }))).status).toBe(403);
  });

  it('lets an admin update features for their club only', async () => {
    const clubA = `test-club-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId: clubA });
    const adminB = await createTestUserAndSession('admin', { clubId: clubB });
    cleanups.push(async () => {
      const db = await getDb();
      await db.getRepository('ClubTenant').delete({ id: clubA });
      await db.getRepository('ClubTenant').delete({ id: clubB });
    }, adminA.cleanup, adminB.cleanup);

    const updated = await PUT(featuresRequest('PUT', adminA.token, {
      features: { scraperSync: false, automaticReminders: false },
    }));
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json() as { success: boolean; features: { scraperSync: boolean; automaticReminders: boolean } };
    expect(updatedBody.success).toBe(true);
    expect(updatedBody.features.scraperSync).toBe(false);
    expect(updatedBody.features.automaticReminders).toBe(false);

    const readA = await GET(featuresRequest('GET', adminA.token));
    expect(readA.status).toBe(200);
    const bodyA = await readA.json() as { features: { scraperSync: boolean; automaticReminders: boolean } };
    expect(bodyA.features.scraperSync).toBe(false);
    expect(bodyA.features.automaticReminders).toBe(false);

    const readB = await GET(featuresRequest('GET', adminB.token));
    expect(readB.status).toBe(200);
    const bodyB = await readB.json() as { features: { scraperSync: boolean; automaticReminders: boolean } };
    expect(bodyB.features.scraperSync).toBe(false);
    expect(bodyB.features.automaticReminders).toBe(true);
  });
});
