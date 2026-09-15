import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { DEFAULT_APP_SETTINGS } from '@/lib/settings';
import { FORBIDDEN_PUBLIC_SETTINGS_KEYS, PUBLIC_CLUB_SETTINGS_KEYS } from '@/lib/settings-public';
import { readAppSettings } from '@/lib/settings-store';
import { GET, PUT } from './route';

const dbAvailable = await isDbAvailable();
const createdClubIds: string[] = [];

function settingsRequest(method: 'GET' | 'PUT', token: string, body?: unknown, clubId?: string) {
  const url = clubId
    ? `http://localhost/api/settings?club=${encodeURIComponent(clubId)}`
    : 'http://localhost/api/settings';
  return new NextRequest(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      cookie: `session_token=${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

function publicSettingsRequest(clubId?: string) {
  const url = clubId
    ? `http://localhost/api/settings?club=${encodeURIComponent(clubId)}`
    : 'http://localhost/api/settings';
  return new NextRequest(url);
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return keys;
  for (const [key, nested] of Object.entries(value)) {
    keys.add(key);
    collectKeys(nested, keys);
  }
  return keys;
}

async function seedClubWithSecrets(clubId: string, name: string) {
  const db = await getDb();
  await db.getRepository('ClubTenant').save({ id: clubId, name, active: true });
  await readAppSettings(db, clubId);
  await db.getRepository('ClubTenant').update(
    { id: clubId },
    {
      logo: 'https://cdn.example.test/logo.png',
      matchesUrlKey: 'platform-controlled-source',
      scraperClubName: 'Platform Controlled Club',
      smtpHost: 'smtp.example.test',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: 'smtp-user',
      smtpFromEmail: 'noreply@example.test',
      smtpFromName: 'Club mailer',
      smtpPasswordEncrypted: 'encrypted-test-secret',
      featuresJson: JSON.stringify({
        ...DEFAULT_APP_SETTINGS.features,
        travelAndWeather: false,
      }),
    },
  );
}

describe.skipIf(!dbAvailable)('GET /api/settings public DTO (issue #21)', () => {
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

  it('returns 404 for an unknown club without creating a tenant', async () => {
    const unknownClub = `unknown-settings-${Date.now()}`;
    const db = await getDb();
    const auditBefore = await db.getRepository('MatchAuditLog').count();
    const rateBefore = await db.query('SELECT COUNT(*) AS c FROM login_rate_limits');

    const response = await GET(publicSettingsRequest(unknownClub));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({ error: 'Not found' });

    const tenant = await db.getRepository('ClubTenant').findOneBy({ id: unknownClub });
    expect(tenant).toBeNull();
    expect(await db.getRepository('MatchAuditLog').count()).toBe(auditBefore);
    const rateAfter = await db.query('SELECT COUNT(*) AS c FROM login_rate_limits');
    expect(Number(rateAfter[0]?.c ?? rateAfter[0]?.C ?? 0)).toBe(Number(rateBefore[0]?.c ?? rateBefore[0]?.C ?? 0));
  });

  it('returns 404 for an inactive club', async () => {
    const clubId = `inactive-settings-${Date.now()}`;
    createdClubIds.push(clubId);
    const db = await getDb();
    await db.getRepository('ClubTenant').save({ id: clubId, name: 'Club inactif', active: false });

    const response = await GET(publicSettingsRequest(clubId));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('does not create the default club on unauthenticated GET without ?club=', async () => {
    const missing = `missing-default-${Date.now()}`;
    const previous = process.env.APP_CLUB_ID;
    process.env.APP_CLUB_ID = missing;
    try {
      const response = await GET(publicSettingsRequest());
      expect(response.status).toBe(404);
      const db = await getDb();
      expect(await db.getRepository('ClubTenant').findOneBy({ id: missing })).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.APP_CLUB_ID;
      else process.env.APP_CLUB_ID = previous;
    }
  });

  it('returns only public branding for an active club', async () => {
    const clubId = `active-settings-${Date.now()}`;
    createdClubIds.push(clubId);
    await seedClubWithSecrets(clubId, 'Club actif');

    const response = await GET(publicSettingsRequest(clubId));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...PUBLIC_CLUB_SETTINGS_KEYS].sort());
    expect(body.clubName).toBe('Club actif');
    expect(body.clubLogo).toBe('');

    const keys = collectKeys(body);
    for (const key of FORBIDDEN_PUBLIC_SETTINGS_KEYS) {
      expect(keys.has(key)).toBe(false);
    }
    const json = JSON.stringify(body);
    expect(json).not.toContain('smtp-user');
    expect(json).not.toContain('smtp.example.test');
    expect(json).not.toContain('platform-controlled-source');
    expect(json).not.toContain('Platform Controlled Club');
    expect(json).not.toContain('encrypted-test-secret');
  });
});

describe.skipIf(!dbAvailable)('/api/settings authenticated contracts (issue #21)', () => {
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

  it('returns admin settings without SMTP password or scraping fields', async () => {
    const clubId = `settings-admin-${Date.now()}`;
    createdClubIds.push(clubId);
    const { token, cleanup } = await createTestUserAndSession('admin', { clubId });

    try {
      await seedClubWithSecrets(clubId, 'Club Admin');

      const getResponse = await GET(settingsRequest('GET', token));
      expect(getResponse.status).toBe(200);
      expect(getResponse.headers.get('Cache-Control')).toContain('no-store');
      const visibleSettings = await getResponse.json() as Record<string, unknown>;
      expect(visibleSettings.clubName).toBe('Club Admin');
      expect(visibleSettings).not.toHaveProperty('matchesUrlKey');
      expect(visibleSettings).not.toHaveProperty('scraperClubName');
      const smtp = visibleSettings.smtp as Record<string, unknown>;
      expect(smtp.host).toBe('smtp.example.test');
      expect(smtp.user).toBe('smtp-user');
      expect(smtp.passwordSet).toBe(true);
      expect(smtp).not.toHaveProperty('password');
      expect(JSON.stringify(visibleSettings)).not.toContain('encrypted-test-secret');
      expect(JSON.stringify(visibleSettings)).not.toContain('"password":');

      const putResponse = await PUT(
        settingsRequest('PUT', token, {
          clubName: 'Club Admin Branding',
          matchesUrlKey: 'attempted-club-override',
          scraperClubName: 'Attempted Club Override',
        }),
      );
      expect(putResponse.status).toBe(200);
      const putBody = await putResponse.json() as { settings: Record<string, unknown> };
      expect(putBody.settings.clubName).toBe('Club Admin Branding');
      expect(putBody.settings).not.toHaveProperty('matchesUrlKey');
      expect(putBody.settings).not.toHaveProperty('scraperClubName');
      expect(putBody.settings.smtp).not.toHaveProperty('password');

      const db = await getDb();
      const storedTenant = await db.getRepository('ClubTenant').findOneByOrFail({ id: clubId });
      expect(storedTenant.matchesUrlKey).toBe('platform-controlled-source');
      expect(storedTenant.scraperClubName).toBe('Platform Controlled Club');
    } finally {
      await cleanup();
    }
  });

  it('omits SMTP from dirigeant responses and hides other clubs', async () => {
    const clubId = `settings-member-${Date.now()}`;
    const otherClubId = `settings-other-${Date.now()}`;
    createdClubIds.push(clubId, otherClubId);
    const { token, cleanup } = await createTestUserAndSession('dirigeant', { clubId });

    try {
      await seedClubWithSecrets(clubId, 'Club membre');
      await seedClubWithSecrets(otherClubId, 'Autre club secret');

      const own = await GET(settingsRequest('GET', token));
      expect(own.status).toBe(200);
      const body = await own.json() as Record<string, unknown>;
      expect(body.clubName).toBe('Club membre');
      expect(body).not.toHaveProperty('smtp');
      expect(body).toHaveProperty('features');
      expect(JSON.stringify(body)).not.toContain('smtp-user');

      const other = await GET(settingsRequest('GET', token, undefined, otherClubId));
      expect(other.status).toBe(404);
      expect(await other.json()).toEqual({ error: 'Not found' });
    } finally {
      await cleanup();
    }
  });
});
