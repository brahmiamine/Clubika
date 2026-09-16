import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { hashPassword } from '@/lib/auth/password';
import { createPlatformSession, PLATFORM_SESSION_COOKIE_NAME } from '@/lib/auth/platform-session';
import { freezeClub } from '@/lib/tenant-offboarding/freeze';
import { purgeClub, residualSearchHits } from '@/lib/tenant-offboarding/purge';
import { POST as opponentPost } from '@/app/api/plateforme/clubs/[id]/opponent-clubs/route';
import { GET as offboardingGet, POST as offboardingPost } from '@/app/api/plateforme/clubs/[id]/offboarding/route';
import { GET as exportGet } from '@/app/api/plateforme/offboarding/exports/[token]/route';
import { TOMBSTONE_CLUB_NAME } from '@/lib/tenant-offboarding/constants';

const dbAvailable = await isDbAvailable();

async function platformAuth() {
  const db = await getDb();
  const admin = await db.getRepository('PlatformAdmin').save({
    email: `offboard-admin-${randomBytes(6).toString('hex')}@example.com`,
    passwordHash: await hashPassword('test-password-123'),
    nom: 'Offboarding Admin',
    active: true,
  });
  const { token } = await createPlatformSession(admin.id);
  return {
    admin,
    token,
    headers: { cookie: `${PLATFORM_SESSION_COOKIE_NAME}=${token}` },
    cleanup: async () => {
      await db.getRepository('PlatformSession').delete({ id: token });
      await db.getRepository('PlatformAdmin').delete({ id: admin.id });
    },
  };
}

async function createClub(id: string, name: string) {
  const db = await getDb();
  await db.getRepository('ClubTenant').save({
    id,
    name,
    abbreviation: 'OB',
    description: '',
    logo: '',
    themeMode: 'system',
    primaryColor: '#1f2937',
    secondaryColor: '#e5e7eb',
    timeZone: 'Europe/Paris',
    matchesUrlKey: '',
    scraperClubName: '',
    featuresJson: '{}',
    active: true,
    offboardingStatus: 'none',
    legalHoldActive: false,
  });
}

describe.skipIf(!dbAvailable)('tenant offboarding (issue #25)', () => {
  const suffix = randomBytes(4).toString('hex');
  const clubA = `oba-${suffix}`;
  const clubB = `obb-${suffix}`;
  const emailA = `alice-${suffix}@example.com`;
  const emailB = `bob-${suffix}@example.com`;
  const nameA = `Alice Sentinel ${suffix}`;
  let authCleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    const db = await getDb();
    for (const clubId of [clubA, clubB]) {
      try {
        await purgeClub(db, clubId, {
          dryRun: false,
          overrideRetention: true,
          confirmClubId: clubId,
          platformAdminId: null,
        });
      } catch {
        await db.query('DELETE FROM users WHERE clubId = ?', [clubId]).catch(() => undefined);
        await db.query('DELETE FROM club_tenants WHERE id = ?', [clubId]).catch(() => undefined);
      }
      await db.query('DELETE FROM tenant_offboarding_events WHERE clubId = ?', [clubId]).catch(() => undefined);
      await db.query('DELETE FROM tenant_processor_instructions WHERE clubId = ?', [clubId]).catch(() => undefined);
      await db.query('DELETE FROM tenant_deletion_certificates WHERE clubId = ?', [clubId]).catch(() => undefined);
      await db.query('DELETE FROM tenant_offboarding_exports WHERE clubId = ?', [clubId]).catch(() => undefined);
      await db.query('DELETE FROM club_tenants WHERE id = ?', [clubId]).catch(() => undefined);
    }
    await authCleanup?.();
  });

  it('gèle, restitue, sèche puis purge un tenant sans toucher l’autre', async () => {
    const db = await getDb();
    const auth = await platformAuth();
    authCleanup = auth.cleanup;
    await createClub(clubA, `Club Alpha ${suffix}`);
    await createClub(clubB, `Club Beta ${suffix}`);

    const userA = await db.getRepository('User').save({
      clubId: clubA,
      email: emailA,
      passwordHash: await hashPassword('test-password-123'),
      nom: nameA,
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      icalToken: randomBytes(12).toString('hex'),
    });
    const userB = await db.getRepository('User').save({
      clubId: clubB,
      email: emailB,
      passwordHash: await hashPassword('test-password-123'),
      nom: `Bob Sentinel ${suffix}`,
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      icalToken: randomBytes(12).toString('hex'),
    });

    await db.getRepository('Invitation').save({
      id: randomBytes(16).toString('hex'),
      clubId: clubA,
      email: emailA,
      accessRole: 'dirigeant',
      planningFunctions: [],
      createdByUserId: userA.id,
      expiresAt: new Date(Date.now() + 86400000),
    });
    await db.query(
      `INSERT INTO planning_records (id, club_id, kind, payload)
       VALUES (?, ?, 'public-share', ?)`,
      [`pr-${suffix}`, clubA, JSON.stringify({ note: emailA })],
    );
    await db.getRepository('MatchAuditLog').save({
      clubId: clubA,
      entityType: 'MatchOfficial',
      entityId: 'm1',
      action: 'create',
      userId: userA.id,
      userEmail: emailA,
      userNom: nameA,
      before: null,
      after: { id: 'm1' },
    });
    await db.getRepository('Club').save({
      clubId: clubA,
      nom: `Adversaire ${suffix}`,
      logo: 'https://example.com/logo.png',
    });

    await freezeClub(db, clubA, { platformAdminId: auth.admin.id, retentionUntil: null });

    const opponent = await opponentPost(
      new NextRequest(`http://localhost/api/plateforme/clubs/${clubA}/opponent-clubs`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ nom: 'Nouveau', logo: 'https://example.com/n.png' }),
      }),
      { params: { id: clubA } },
    );
    expect(opponent.status).toBe(409);

    const issued = await offboardingPost(
      new NextRequest(`http://localhost/api/plateforme/clubs/${clubA}/offboarding`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'export' }),
      }),
      { params: { id: clubA } },
    );
    expect(issued.status).toBe(200);
    const issuedBody = await issued.json() as { token: string };
    const download = await exportGet(
      new NextRequest(`http://localhost/api/plateforme/offboarding/exports/${issuedBody.token}`, {
        headers: auth.headers,
      }),
      { params: { token: issuedBody.token } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('Cache-Control')).toContain('no-store');
    const archive = await download.json() as { ciphertext: string; manifestSha256: string };
    expect(archive.ciphertext).toBeTruthy();
    expect(JSON.stringify(archive)).not.toContain(userA.passwordHash);
    const replay = await exportGet(
      new NextRequest(`http://localhost/api/plateforme/offboarding/exports/${issuedBody.token}`, {
        headers: auth.headers,
      }),
      { params: { token: issuedBody.token } },
    );
    expect(replay.status).toBe(410);

    const dry = await purgeClub(db, clubA, {
      dryRun: true,
      overrideRetention: true,
      platformAdminId: auth.admin.id,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.stores.some((row) => row.id === 'users' && row.scanned >= 1 && row.deleted === 0)).toBe(true);
    expect(await db.getRepository('User').findOneBy({ id: userA.id })).toBeTruthy();

    const purged = await purgeClub(db, clubA, {
      dryRun: false,
      overrideRetention: true,
      confirmClubId: clubA,
      platformAdminId: auth.admin.id,
    });
    expect(purged.success).toBe(true);
    expect(purged.certificate).toBeTruthy();
    expect(JSON.stringify(purged.certificate)).not.toContain(emailA);
    expect(JSON.stringify(purged.certificate)).not.toContain(nameA);

    const hits = await residualSearchHits(db, clubA, [emailA, nameA]);
    expect(hits).toEqual([]);
    const tombstone = await db.getRepository('ClubTenant').findOneBy({ id: clubA });
    expect(tombstone?.name).toBe(TOMBSTONE_CLUB_NAME);
    expect(tombstone?.offboardingStatus).toBe('purged');

    const survivor = await db.getRepository('User').findOneBy({ id: userB.id });
    expect(survivor?.email).toBe(emailB);

    const again = await purgeClub(db, clubA, {
      dryRun: false,
      overrideRetention: true,
      confirmClubId: clubA,
      platformAdminId: auth.admin.id,
    });
    expect(again.certificate).toBeTruthy();

    const status = await offboardingGet(
      new NextRequest(`http://localhost/api/plateforme/clubs/${clubA}/offboarding`, { headers: auth.headers }),
      { params: { id: clubA } },
    );
    const statusBody = await status.json() as { club: { name: string }; certificate: { clubIdHash: string } };
    expect(statusBody.club.name).toBe(TOMBSTONE_CLUB_NAME);
    expect(statusBody.certificate.clubIdHash).toHaveLength(64);
  });

  it('refuse la purge sous legal hold', async () => {
    const db = await getDb();
    const auth = await platformAuth();
    authCleanup = auth.cleanup;
    await createClub(clubA, `Hold ${suffix}`);
    const hold = await offboardingPost(
      new NextRequest(`http://localhost/api/plateforme/clubs/${clubA}/offboarding`, {
        method: 'POST',
        headers: { ...auth.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'legal-hold',
          motive: 'litige',
          scope: 'full_tenant',
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        }),
      }),
      { params: { id: clubA } },
    );
    expect(hold.status).toBe(200);
    await expect(purgeClub(db, clubA, {
      dryRun: false,
      overrideRetention: true,
      confirmClubId: clubA,
      platformAdminId: auth.admin.id,
    })).rejects.toThrow(/legal hold/i);
  });
});
