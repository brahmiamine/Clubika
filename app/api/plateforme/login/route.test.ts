import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { PlatformAdminEntity } from '@/lib/db/schemas';
import { hashPassword } from '@/lib/auth/password';
import { checkLoginRateLimit, hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

// Chaque test simule une IP distincte (issue #274) : sans cela, tous les échecs de
// connexion de ce fichier partageraient le même bucket de limitation de débit.
function loginRequest(body: unknown, ip = randomBytes(8).toString('hex')) {
  return new NextRequest('http://localhost/api/plateforme/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  });
}

describe.skipIf(!dbAvailable)('POST /api/plateforme/login (integration)', () => {
  const email = `platform-login-test-${randomBytes(6).toString('hex')}@example.com`;
  let adminId: number;

  afterEach(async () => {
    const db = await getDb();
    if (adminId) {
      await db.getRepository('PlatformSession').createQueryBuilder().delete().where('platformAdminId = :adminId', { adminId }).execute();
      await db.getRepository('PlatformAdmin').delete({ id: adminId });
    }
    await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`platform-login:identity:${hashBucketComponent(email)}`]);
  });

  it('logs in with correct credentials and sets a platform session cookie', async () => {
    const db = await getDb();
    const admin = await db.getRepository<PlatformAdminEntity>('PlatformAdmin').save({
      email,
      passwordHash: await hashPassword('correct-password'),
      nom: 'Platform Login Test',
      active: true,
    });
    adminId = admin.id;

    const response = await POST(loginRequest({ email, password: 'correct-password' }));
    expect(response.status).toBe(200);
    const body = await response.json() as { mfaEnrollmentRequired?: boolean; success?: boolean };
    expect(body.mfaEnrollmentRequired).toBe(true);
    expect(response.cookies.get('platform_session_token')?.value).toBeFalsy();
    expect(response.cookies.get('platform_mfa_pending')?.value).toBeTruthy();
  });

  it('rejects an incorrect password', async () => {
    const response = await POST(loginRequest({ email, password: 'wrong-password' }));
    expect(response.status).toBe(401);
  });

  it('rejects a login for an inactive platform admin', async () => {
    const db = await getDb();
    await db.getRepository<PlatformAdminEntity>('PlatformAdmin').update({ id: adminId }, { active: false });

    const response = await POST(loginRequest({ email, password: 'correct-password' }));
    expect(response.status).toBe(401);
  });

  it('rejects an unknown email with the same generic message as a known one', async () => {
    const unknown = await POST(loginRequest({ email: `nobody-${randomBytes(6).toString('hex')}@example.com`, password: 'x' }));
    const known = await POST(loginRequest({ email, password: 'wrong-password' }));
    const unknownBody = await unknown.json();
    const knownBody = await known.json();
    expect(unknownBody.error).toBe(knownBody.error);
    expect(unknown.status).toBe(known.status);
  });
});

describe.skipIf(!dbAvailable)('POST /api/plateforme/login — limitation de débit (issue #274)', () => {
  const email = `platform-rate-limit-${randomBytes(6).toString('hex')}@example.com`;

  afterEach(async () => {
    const db = await getDb();
    await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`platform-login:identity:${hashBucketComponent(email)}`]);
  });

  it('bloque avec 429 après 5 échecs pour la même identité', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await POST(loginRequest({ email, password: 'toujours-faux' }));
      expect(response.status).toBe(401);
    }
    const blocked = await POST(loginRequest({ email, password: 'toujours-faux' }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('utilise un compteur distinct de la connexion club (même adresse email)', async () => {
    const db = await getDb();
    // Verrouille le bucket "connexion club" pour cette même adresse ; le bucket
    // "connexion plateforme", distinct par préfixe, ne doit pas en hériter.
    const clubIdentityBucket = `login:identity:${hashBucketComponent(email)}`;
    for (let i = 0; i < 5; i += 1) {
      await db.query(
        `INSERT INTO login_rate_limits (bucket_key, attempts, first_attempt_at, last_attempt_at, locked_until)
         VALUES (?, 1, NOW(6), NOW(6), NULL)
         ON DUPLICATE KEY UPDATE attempts = attempts + 1`,
        [clubIdentityBucket],
      );
    }
    await db.query('UPDATE login_rate_limits SET locked_until = DATE_ADD(NOW(6), INTERVAL 30 SECOND) WHERE bucket_key = ?', [clubIdentityBucket]);

    try {
      const response = await POST(loginRequest({ email, password: 'toujours-faux' }));
      expect(response.status).toBe(401);
      const platformStatus = await checkLoginRateLimit(db, `platform-login:identity:${hashBucketComponent(email)}`);
      expect(platformStatus.limited).toBe(false);
    } finally {
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [clubIdentityBucket]);
    }
  });
});
