import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { GET } from './route';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { getDb } from '@/lib/db';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('GET /api/invitations/context (issue #34)', () => {
  it('refuse un contexte absent avec la même forme qu’un jeton inconnu', async () => {
    const ip = randomBytes(8).toString('hex');
    try {
      const response = await GET(new NextRequest('http://localhost/api/invitations/context', {
        headers: { 'x-forwarded-for': ip },
      }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ valid: false });
      expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    } finally {
      const db = await getDb();
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`invitation-validate:ip:${hashBucketComponent(ip)}`]);
    }
  });
});
