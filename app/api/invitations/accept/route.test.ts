import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { POST } from './route';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { getDb } from '@/lib/db';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('POST /api/invitations/accept (issue #34)', () => {
  it('refuse une acceptation sans cookie de contexte', async () => {
    const ip = randomBytes(8).toString('hex');
    try {
      const response = await POST(new NextRequest('http://localhost/api/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({
          email: `ctx-missing-${randomBytes(6).toString('hex')}@example.com`,
          password: 'password123',
          nom: 'Invitee',
          confirmIdentity: true,
          acknowledgeNotice: true,
        }),
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
      }));
      expect(response.status).toBe(404);
      expect(JSON.stringify(await response.json())).not.toMatch(/[a-f0-9]{48}/);
    } finally {
      const db = await getDb();
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`invitation-accept:ip:${hashBucketComponent(ip)}`]);
    }
  });
});
