import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession, enableTrustedProxyHeaders, uniqueTestIp } from '@/lib/auth/test-helpers';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { GET } from './route';

const dbAvailable = await isDbAvailable();

function icalRequest(token: string, ip = uniqueTestIp()) {
  return new NextRequest(`http://localhost/api/ical/${token}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

describe.skipIf(!dbAvailable)('GET /api/ical/[token] — limitation de débit (issue #381)', () => {
  const cleanupIps: string[] = [];
  const cleanupTokens: string[] = [];
  let restoreProxy: (() => void) | undefined;

  beforeEach(() => {
    restoreProxy = enableTrustedProxyHeaders();
  });

  afterEach(async () => {
    restoreProxy?.();
    const db = await getDb();
    for (const ip of cleanupIps.splice(0)) {
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`ical-feed:ip:${hashBucketComponent(ip)}`]);
    }
    for (const token of cleanupTokens.splice(0)) {
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`ical-feed:token:${hashBucketComponent(token)}`]);
    }
  });

  it('renvoie 429 après 5 sondes sur un jeton invalide depuis la même IP', async () => {
    const ip = uniqueTestIp();
    cleanupIps.push(ip);
    const token = `invalid-probe-${randomBytes(8).toString('hex')}`;

    for (let i = 0; i < 5; i += 1) {
      const response = await GET(icalRequest(token, ip) as never, { params: { token } });
      expect(response.status).toBe(404);
    }

    cleanupTokens.push(token);
    const blocked = await GET(icalRequest(token, ip) as never, { params: { token } });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });
});

describe.skipIf(!dbAvailable)('GET /api/ical/[token] — club désactivé (issue #213)', () => {
  it('refuse un jeton iCal par ailleurs valide une fois le club désactivé, sans distinguer le motif', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const { user, cleanup } = await createTestUserAndSession('dirigeant', { clubId }, ['arbitre_club']);
    const db = await getDb();
    const ip = uniqueTestIp();

    try {
      const workingResponse = await GET(
        icalRequest(user.icalToken, ip) as never,
        { params: { token: user.icalToken } },
      );
      expect(workingResponse.status).toBe(200);

      await db.getRepository('ClubTenant').save({ id: clubId, name: 'Club test désactivé', active: false });

      const disabledResponse = await GET(
        icalRequest(user.icalToken, ip) as never,
        { params: { token: user.icalToken } },
      );
      expect(disabledResponse.status).toBe(404);
      const disabledBody = await disabledResponse.json();

      const invalidResponse = await GET(
        icalRequest('jeton-inexistant', ip) as never,
        { params: { token: 'jeton-inexistant' } },
      );
      const invalidBody = await invalidResponse.json();

      // Même statut, même message : un client ne doit pas pouvoir distinguer
      // « club désactivé » de « jeton invalide ».
      expect(disabledResponse.status).toBe(invalidResponse.status);
      expect(disabledBody.error).toBe(invalidBody.error);
    } finally {
      await db.getRepository('ClubTenant').delete({ id: clubId });
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`ical-feed:ip:${hashBucketComponent(ip)}`]);
      await cleanup();
    }
  });
});
