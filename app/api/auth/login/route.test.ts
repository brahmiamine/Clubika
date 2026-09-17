import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { hashPassword } from '@/lib/auth/password';
import { checkLoginRateLimit, hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { enableTrustedProxyHeaders, uniqueTestIp } from '@/lib/auth/test-helpers';
import { getSessionUser } from '@/lib/auth/session';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

function loginRequest(body: unknown, ip = uniqueTestIp()) {
  return new NextRequest('http://localhost/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  });
}

describe.skipIf(!dbAvailable)('POST /api/auth/login (integration)', () => {
  const email = `login-test-${Date.now()}@example.com`;
  let userId: number;
  let restoreProxy: (() => void) | undefined;

  beforeEach(() => {
    restoreProxy = enableTrustedProxyHeaders();
  });

  afterEach(async () => {
    restoreProxy?.();
    if (userId) {
      const db = await getDb();
      await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :userId', { userId }).execute();
      await db.getRepository('User').delete({ id: userId });
    }
    const db = await getDb();
    await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`login:identity:${hashBucketComponent(email)}`]);
  });

  it('logs in with correct credentials and sets a session cookie', async () => {
    const db = await getDb();
    const user = await db.getRepository<UserEntity>('User').save({
      email,
      passwordHash: await hashPassword('correct-password'),
      nom: 'Login Test',
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      personLinks: [],
    });
    userId = user.id;

    const response = await POST(loginRequest({ email, password: 'correct-password' }));
    expect(response.status).toBe(200);
    const cookie = response.cookies.get('session_token');
    expect(cookie?.value).toBeTruthy();
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe('/');
    expect(cookie?.sameSite).toBe('lax');
  });

  it('rotates the previous session cookie on a new login (issue #29)', async () => {
    const db = await getDb();
    const user = await db.getRepository<UserEntity>('User').save({
      email,
      passwordHash: await hashPassword('correct-password'),
      nom: 'Login Rotation',
      accessRole: 'dirigeant',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      personLinks: [],
    });
    userId = user.id;

    const first = await POST(loginRequest({ email, password: 'correct-password' }));
    const firstToken = first.cookies.get('session_token')?.value;
    expect(firstToken).toBeTruthy();

    const second = await POST(new NextRequest('http://localhost/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct-password' }),
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': uniqueTestIp(),
        cookie: `session_token=${firstToken}`,
      },
    }));
    const secondToken = second.cookies.get('session_token')?.value;
    expect(secondToken).toBeTruthy();
    expect(secondToken).not.toBe(firstToken);
    expect(await getSessionUser(firstToken)).toBeNull();
    expect(await getSessionUser(secondToken)).not.toBeNull();
  });

  it('rejects an incorrect password', async () => {
    const response = await POST(loginRequest({ email, password: 'wrong-password' }));
    expect(response.status).toBe(401);
  });

  it('rejects a login for an unclaimed profile, even with a known password (issue #204)', async () => {
    const db = await getDb();
    const placeholderEmail = `profil-${Date.now()}@sans-acces.local`;
    const placeholder = await db.getRepository<UserEntity>('User').save({
      clubId: `test-club-${Date.now()}`,
      email: placeholderEmail,
      passwordHash: await hashPassword('known-password-123'),
      nom: 'Profil Sans Accès',
      accessRole: 'dirigeant',
      planningFunctions: ['arbitre_club'],
      active: true,
      // Profil créé par un référentiel de fonction : jamais activé, pas de session.
      claimedAt: null,
    });
    try {
      const response = await POST(loginRequest({ email: placeholderEmail, password: 'known-password-123' }));
      expect(response.status).toBe(401);
      expect(response.cookies.get('session_token')).toBeUndefined();
    } finally {
      await db.getRepository('User').delete({ id: placeholder.id });
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`login:identity:${hashBucketComponent(placeholderEmail)}`]);
    }
  });

  it('rejects a login for an inactive user', async () => {
    const db = await getDb();
    await db.getRepository<UserEntity>('User').update({ id: userId }, { active: false });

    const response = await POST(loginRequest({ email, password: 'correct-password' }));
    expect(response.status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)('POST /api/auth/login — même email dans deux clubs (issue #266)', () => {
  it('se connecte au compte dont le mot de passe correspond, en l\'absence de sélecteur de club', async () => {
    const db = await getDb();
    const email = `multi-club-login-${randomBytes(6).toString('hex')}@example.com`;
    const clubA = `test-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-b-${randomBytes(6).toString('hex')}`;
    const userRepo = db.getRepository<UserEntity>('User');
    const userA = await userRepo.save({
      clubId: clubA,
      email,
      passwordHash: await hashPassword('password-club-a'),
      nom: 'Dirigeant Club A',
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
    });
    const userB = await userRepo.save({
      clubId: clubB,
      email,
      passwordHash: await hashPassword('password-club-b'),
      nom: 'Dirigeant Club B',
      accessRole: 'dirigeant',
      planningFunctions: ['arbitre_club'],
      active: true,
      claimedAt: new Date(),
    });

    try {
      // Le mot de passe du club A désambiguïse vers le compte admin du club A.
      const responseA = await POST(loginRequest({ email, password: 'password-club-a' }));
      expect(responseA.status).toBe(200);
      expect((await responseA.json()).redirectTo).toBe('/club');

      // Le mot de passe du club B désambiguïse vers l'autre compte, indépendant.
      const responseB = await POST(loginRequest({ email, password: 'password-club-b' }));
      expect(responseB.status).toBe(200);
      expect((await responseB.json()).redirectTo).toBe('/mon-planning');

      const wrongResponse = await POST(loginRequest({ email, password: 'mot-de-passe-inconnu' }));
      expect(wrongResponse.status).toBe(401);
    } finally {
      await db.getRepository('UserSession').createQueryBuilder().delete()
        .where('userId IN (:...ids)', { ids: [userA.id, userB.id] }).execute();
      await userRepo.delete({ id: userA.id });
      await userRepo.delete({ id: userB.id });
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`login:identity:${hashBucketComponent(email)}`]);
    }
  });
});

describe.skipIf(!dbAvailable)('POST /api/auth/login — sélecteur de club (issue #347)', () => {
  it('demande le club quand le même email et mot de passe correspondent à plusieurs comptes', async () => {
    const db = await getDb();
    const email = `shared-password-login-${randomBytes(6).toString('hex')}@example.com`;
    const password = 'mot-de-passe-partage';
    const clubA = `selector-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `selector-club-b-${randomBytes(6).toString('hex')}`;
    const userRepo = db.getRepository<UserEntity>('User');
    await db.getRepository('ClubTenant').save([
      { id: clubA, name: 'Club Alpha', active: true },
      { id: clubB, name: 'Club Beta', active: true },
    ]);
    const userA = await userRepo.save({
      clubId: clubA,
      email,
      passwordHash: await hashPassword(password),
      nom: 'Admin Alpha',
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
    });
    const userB = await userRepo.save({
      clubId: clubB,
      email,
      passwordHash: await hashPassword(password),
      nom: 'Dirigeant Beta',
      accessRole: 'dirigeant',
      planningFunctions: ['arbitre_club'],
      active: true,
      claimedAt: new Date(),
    });

    try {
      const ambiguous = await POST(loginRequest({ email, password }));
      expect(ambiguous.status).toBe(409);
      const body = await ambiguous.json();
      expect(body.requiresClubSelection).toBe(true);
      expect(body.clubs).toEqual([
        { clubId: clubA, clubName: 'Club Alpha' },
        { clubId: clubB, clubName: 'Club Beta' },
      ]);

      const loginB = await POST(loginRequest({ email, password, clubId: clubB }));
      expect(loginB.status).toBe(200);
      expect((await loginB.json()).redirectTo).toBe('/mon-planning');
      expect(loginB.cookies.get('session_token')?.value).toBeTruthy();
    } finally {
      await db.getRepository('UserSession').createQueryBuilder().delete()
        .where('userId IN (:...ids)', { ids: [userA.id, userB.id] }).execute();
      await userRepo.delete({ id: userA.id });
      await userRepo.delete({ id: userB.id });
      await db.getRepository('ClubTenant').delete({ id: clubA });
      await db.getRepository('ClubTenant').delete({ id: clubB });
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`login:identity:${hashBucketComponent(email)}`]);
    }
  });
});

describe.skipIf(!dbAvailable)('POST /api/auth/login — limitation de débit (issue #274)', () => {
  const email = `rate-limit-test-${randomBytes(6).toString('hex')}@example.com`;
  let restoreProxy: (() => void) | undefined;

  beforeEach(() => {
    restoreProxy = enableTrustedProxyHeaders();
  });

  afterEach(async () => {
    restoreProxy?.();
    const db = await getDb();
    await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`login:identity:${hashBucketComponent(email)}`]);
  });

  it('bloque avec 429 après 5 échecs pour la même identité, même depuis des IP différentes', async () => {
    for (let i = 0; i < 5; i += 1) {
      const response = await POST(loginRequest({ email, password: 'toujours-faux' }));
      expect(response.status).toBe(401);
    }
    const blocked = await POST(loginRequest({ email, password: 'toujours-faux' }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('Retry-After')).toBeTruthy();
  });

  it('bloque avec 429 après 5 échecs depuis la même IP, même avec des identités différentes', async () => {
    const ip = uniqueTestIp();
    const cleanupEmails: string[] = [];
    try {
      for (let i = 0; i < 5; i += 1) {
        const distinctEmail = `rate-limit-ip-${i}-${randomBytes(4).toString('hex')}@example.com`;
        cleanupEmails.push(distinctEmail);
        const response = await POST(loginRequest({ email: distinctEmail, password: 'toujours-faux' }, ip));
        expect(response.status).toBe(401);
      }
      const blocked = await POST(loginRequest({ email: `rate-limit-ip-final-${randomBytes(4).toString('hex')}@example.com`, password: 'x' }, ip));
      expect(blocked.status).toBe(429);
    } finally {
      const db = await getDb();
      for (const usedEmail of cleanupEmails) {
        await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`login:identity:${hashBucketComponent(usedEmail)}`]);
      }
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`login:ip:${hashBucketComponent(ip)}`]);
    }
  });

  it('une connexion réussie réinitialise la limite pour cette identité', async () => {
    const db = await getDb();
    const password = 'correct-password-274';
    const user = await db.getRepository<UserEntity>('User').save({
      email,
      passwordHash: await hashPassword(password),
      nom: 'Rate Limit Reset Test',
      accessRole: 'dirigeant',
      planningFunctions: ['arbitre_club'],
      active: true,
      claimedAt: new Date(),
    });
    try {
      // 4 échecs (sous le premier palier de 5) puis un succès : si la réinitialisation
      // ne fonctionnait pas, 4 nouveaux échecs après le succès cumuleraient à 8 —
      // franchissant le second palier (verrouillage à 8) — la preuve que la
      // réinitialisation a bien eu lieu est donc qu'ils ne le franchissent PAS.
      for (let i = 0; i < 4; i += 1) {
        const response = await POST(loginRequest({ email, password: 'mauvais' }));
        expect(response.status).toBe(401);
      }
      const success = await POST(loginRequest({ email, password }));
      expect(success.status).toBe(200);

      for (let i = 0; i < 4; i += 1) {
        const response = await POST(loginRequest({ email, password: 'mauvais-encore' }));
        expect(response.status).toBe(401);
      }

      // État directement inspecté (plutôt que déduit des codes de réponse, qui ne
      // reflètent jamais un verrouillage posé par la requête elle-même) : le compteur
      // n'a pas atteint le second palier, preuve que le succès l'a bien remis à zéro.
      const resetStatus = await checkLoginRateLimit(db, `login:identity:${hashBucketComponent(email)}`);
      expect(resetStatus.limited).toBe(false);
    } finally {
      await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :userId', { userId: user.id }).execute();
      await db.getRepository('User').delete({ id: user.id });
    }
  });
});
