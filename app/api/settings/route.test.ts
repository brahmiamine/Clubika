import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession, enableTrustedProxyHeaders, uniqueTestIp } from '@/lib/auth/test-helpers';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { readAppSettings } from '@/lib/settings-store';
import { GET, PUT } from './route';

const dbAvailable = await isDbAvailable();
const createdClubIds: string[] = [];

function settingsRequest(method: 'GET' | 'PUT', token: string, body?: unknown) {
  return new NextRequest('http://localhost/api/settings', {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      cookie: `session_token=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

function publicSettingsRequest(clubId: string, ip = uniqueTestIp()) {
  return new NextRequest(`http://localhost/api/settings?club=${encodeURIComponent(clubId)}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

describe.skipIf(!dbAvailable)('GET /api/settings public club lookup (issue #342)', () => {
  const cleanupIps: string[] = [];
  let restoreProxy: (() => void) | undefined;

  beforeEach(() => {
    restoreProxy = enableTrustedProxyHeaders();
  });

  afterEach(async () => {
    restoreProxy?.();
    const db = await getDb();
    for (const ip of cleanupIps.splice(0)) {
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`settings-public:ip:${hashBucketComponent(ip)}`]);
    }
    if (createdClubIds.length === 0) return;
    await db
      .getRepository('ClubTenant')
      .createQueryBuilder()
      .delete()
      .where('id IN (:...ids)', { ids: createdClubIds })
      .execute();
    createdClubIds.length = 0;
  });

  it('returns 404 for an unknown club without creating a tenant', async () => {
    const unknownClub = `unknown-settings-${Date.now()}`;
    const ip = uniqueTestIp();
    cleanupIps.push(ip);

    const response = await GET(publicSettingsRequest(unknownClub, ip));
    expect(response.status).toBe(404);

    const db = await getDb();
    const tenant = await db.getRepository('ClubTenant').findOneBy({ id: unknownClub });
    expect(tenant).toBeNull();
  });

  it('returns 404 for an inactive club', async () => {
    const clubId = `inactive-settings-${Date.now()}`;
    createdClubIds.push(clubId);
    const ip = uniqueTestIp();
    cleanupIps.push(ip);
    const db = await getDb();
    await db.getRepository('ClubTenant').save({ id: clubId, name: 'Club inactif', active: false });

    const response = await GET(publicSettingsRequest(clubId, ip));
    expect(response.status).toBe(404);
  });

  it('returns settings for an active club', async () => {
    const clubId = `active-settings-${Date.now()}`;
    createdClubIds.push(clubId);
    const ip = uniqueTestIp();
    cleanupIps.push(ip);
    const db = await getDb();
    await db.getRepository('ClubTenant').save({ id: clubId, name: 'Club actif', active: true });
    await readAppSettings(db, clubId);

    const response = await GET(publicSettingsRequest(clubId, ip));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.clubName).toBe('Club actif');
  });
});

describe.skipIf(!dbAvailable)('/api/settings scraping isolation (integration)', () => {
  afterEach(async () => {
    if (createdClubIds.length === 0) return;
    const db = await getDb();
    await db
      .getRepository('ClubTenant')
      .createQueryBuilder()
      .delete()
      .where('id IN (:...ids)', { ids: createdClubIds })
      .execute();
    createdClubIds.length = 0;
  });

  it('does not expose or allow a club admin to modify platform-owned scraping settings', async () => {
    const clubId = `settings-scraping-${Date.now()}`;
    createdClubIds.push(clubId);
    const { token, cleanup } = await createTestUserAndSession('admin', { clubId });

    try {
      const db = await getDb();
      await readAppSettings(db, clubId);
      await db.getRepository('ClubTenant').update(
        { id: clubId },
        {
          matchesUrlKey: 'platform-controlled-source',
          scraperClubName: 'Platform Controlled Club',
        },
      );

      const getResponse = await GET(settingsRequest('GET', token));
      expect(getResponse.status).toBe(200);
      const visibleSettings = await getResponse.json();
      expect(visibleSettings.matchesUrlKey).toBe('');
      expect(visibleSettings.scraperClubName).toBe('');

      const putResponse = await PUT(
        settingsRequest('PUT', token, {
          clubName: 'Club Admin Branding',
          matchesUrlKey: 'attempted-club-override',
          scraperClubName: 'Attempted Club Override',
        }),
      );
      expect(putResponse.status).toBe(200);
      const putBody = await putResponse.json();
      expect(putBody.settings.clubName).toBe('Club Admin Branding');
      expect(putBody.settings.matchesUrlKey).toBe('');
      expect(putBody.settings.scraperClubName).toBe('');

      const storedTenant = await db.getRepository('ClubTenant').findOneByOrFail({ id: clubId });
      expect(storedTenant.matchesUrlKey).toBe('platform-controlled-source');
      expect(storedTenant.scraperClubName).toBe('Platform Controlled Club');
    } finally {
      await cleanup();
    }
  });
});
