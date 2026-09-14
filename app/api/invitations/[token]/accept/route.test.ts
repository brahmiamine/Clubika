import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { InvitationEntity, UserEntity } from '@/lib/db/schemas';
import { hashInvitationToken } from '@/lib/auth/invitation-tokens';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

let creatorUserId = 0;
let cleanupCreator: (() => Promise<void>) | null = null;

async function ensureCreatorUser() {
  if (creatorUserId > 0) {
    const db = await getDb();
    const existing = await db.getRepository<UserEntity>('User').findOneBy({ id: creatorUserId });
    if (existing) return creatorUserId;
    creatorUserId = 0;
    cleanupCreator = null;
  }
  const { user, cleanup } = await createTestUserAndSession('admin');
  creatorUserId = user.id;
  cleanupCreator = cleanup;
  return creatorUserId;
}

function acceptRequest(token: string, body: unknown, ip = randomBytes(8).toString('hex')) {
  return new NextRequest(`http://localhost/api/invitations/${token}/accept`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
  });
}

// Seule l'empreinte du jeton est stockée en base (issue #271) : les tests créent
// l'invitation avec un jeton brut connu et le renvoient à part (`rawToken`), tandis
// que `id` reste l'empreinte réellement persistée en base.
async function createInvitation(overrides?: Partial<InvitationEntity>) {
  const db = await getDb();
  const repo = db.getRepository<InvitationEntity>('Invitation');
  const rawToken = randomBytes(24).toString('hex');
  const invitation = await repo.save({
    id: hashInvitationToken(rawToken),
    clubId: process.env.APP_CLUB_ID || 'afp',
    email: null,
    pendingEmailKey: null,
    accessRole: 'dirigeant',
    planningFunctions: ['arbitre_club'],
    personNom: null,
    createdByUserId: await ensureCreatorUser(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    usedAt: null,
    usedByUserId: null,
    ...overrides,
  });
  return { ...invitation, rawToken };
}

describe.skipIf(!dbAvailable)('POST /api/invitations/[token]/accept (integration)', () => {
  const createdEmails: string[] = [];

  afterEach(async () => {
    const db = await getDb();
    if (createdEmails.length > 0) {
      await db.getRepository('User').createQueryBuilder().delete().where('email IN (:...emails)', { emails: createdEmails }).execute();
      createdEmails.length = 0;
    }
  });

  it('creates a user and logs them in for a valid unused token', async () => {
    const invitation = await createInvitation({ accessRole: 'admin', planningFunctions: [] });
    const email = `invitee-${randomBytes(8).toString('hex')}@example.com`;
    createdEmails.push(email);

    const response = await POST(acceptRequest(invitation.rawToken, { email, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Invitee' }), {
      params: { token: invitation.rawToken },
    });

    expect(response.status).toBe(200);
    expect(response.cookies.get('session_token')?.value).toBeTruthy();
    expect((await response.json()).redirectTo).toBe('/club');
    expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
  });

  it('refuse l’acceptation sans confirmation explicite d’identité et de notice (issue #34)', async () => {
    const invitation = await createInvitation({ accessRole: 'dirigeant', planningFunctions: [] });
    const email = `noconfirm-${randomBytes(8).toString('hex')}@example.com`;
    const response = await POST(
      acceptRequest(invitation.rawToken, { email, password: 'password123', nom: 'X' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/Confirmez/) });
  });

  it('accepte via le cookie de contexte sans renvoyer le jeton (issue #34)', async () => {
    const invitation = await createInvitation({ accessRole: 'dirigeant', planningFunctions: [] });
    const email = `ctx-${randomBytes(8).toString('hex')}@example.com`;
    createdEmails.push(email);
    const { GET: validateGet } = await import('../route');
    const { POST: acceptFromContext } = await import('../../accept/route');
    const ip = randomBytes(8).toString('hex');
    const validate = await validateGet(
      new NextRequest(`http://localhost/api/invitations/${invitation.rawToken}`, {
        headers: { 'x-forwarded-for': ip },
      }),
      { params: { token: invitation.rawToken } },
    );
    expect(validate.status).toBe(200);
    const contextToken = validate.cookies.get('invitation_ctx')?.value;
    expect(contextToken).toBeTruthy();

    const response = await acceptFromContext(new NextRequest('http://localhost/api/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: 'password123',
        nom: 'Invitee',
        confirmIdentity: true,
        acknowledgeNotice: true,
      }),
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': ip,
        cookie: `invitation_ctx=${contextToken}`,
      },
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.redirectTo).toBe('/mon-planning');
    expect(JSON.stringify(body)).not.toContain(invitation.rawToken);
    expect(JSON.stringify(body)).not.toContain(contextToken);
  });

  it('exactement une acceptation réussit quand deux requêtes concurrentes utilisent le même jeton (issue #271)', async () => {
    const invitation = await createInvitation({ accessRole: 'dirigeant', planningFunctions: [] });
    const emailA = `race-a-${randomBytes(8).toString('hex')}@example.com`;
    const emailB = `race-b-${randomBytes(8).toString('hex')}@example.com`;
    createdEmails.push(emailA, emailB);

    const [first, second] = await Promise.all([
      POST(acceptRequest(invitation.rawToken, { email: emailA, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Course A' }), {
        params: { token: invitation.rawToken },
      }),
      POST(acceptRequest(invitation.rawToken, { email: emailB, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Course B' }), {
        params: { token: invitation.rawToken },
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const db = await getDb();
    const createdA = await db.getRepository('User').findOneBy({ email: emailA });
    const createdB = await db.getRepository('User').findOneBy({ email: emailB });
    // Un seul des deux comptes a réellement été créé : jamais les deux pour un même lien.
    expect([createdA, createdB].filter(Boolean)).toHaveLength(1);

    const reloadedInvitation = await db.getRepository<InvitationEntity>('Invitation').findOneBy({ id: invitation.id });
    expect(reloadedInvitation?.usedByUserId).toBe((createdA ?? createdB)!.id);
  });

  it('rejects an invitation acceptance when the email already has an account in the same club', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const email = `already-in-club-${randomBytes(8).toString('hex')}@example.com`;
    createdEmails.push(email);
    const db = await getDb();
    await db.getRepository<UserEntity>('User').save({
      clubId,
      email,
      passwordHash: 'hash',
      nom: 'Déjà présent',
      accessRole: 'dirigeant',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      icalToken: `ical-${randomBytes(6).toString('hex')}`,
    });

    const invitation = await createInvitation({ clubId, accessRole: 'dirigeant', planningFunctions: [] });
    const response = await POST(
      acceptRequest(invitation.rawToken, { email, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Nouveau' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(400);
  });

  it('accepts an invitation with an email that already has an account in a different club (issue #266)', async () => {
    const clubA = `test-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-b-${randomBytes(6).toString('hex')}`;
    const email = `multi-club-dirigeant-${randomBytes(8).toString('hex')}@example.com`;
    createdEmails.push(email);
    const db = await getDb();
    const existingAccount = await db.getRepository<UserEntity>('User').save({
      clubId: clubA,
      email,
      passwordHash: 'hash-club-a',
      nom: 'Dirigeant Club A',
      accessRole: 'dirigeant',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      icalToken: `ical-${randomBytes(6).toString('hex')}`,
    });

    const invitation = await createInvitation({ clubId: clubB, accessRole: 'dirigeant', planningFunctions: [] });
    const response = await POST(
      acceptRequest(invitation.rawToken, { email, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Dirigeant Club B' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(200);
    expect(response.cookies.get('session_token')?.value).toBeTruthy();

    const accounts = await db.getRepository<UserEntity>('User').find({ where: { email } });
    expect(accounts).toHaveLength(2);
    const clubIds = accounts.map((account) => account.clubId).sort();
    expect(clubIds).toEqual([clubA, clubB].sort());
    // Deux comptes distincts, chacun avec son propre mot de passe : accepter
    // l'invitation dans le club B ne doit jamais modifier le compte du club A.
    const untouchedAccountA = accounts.find((account) => account.clubId === clubA);
    expect(untouchedAccountA?.id).toBe(existingAccount.id);
    expect(untouchedAccountA?.passwordHash).toBe('hash-club-a');
  });

  it('rejects an expired invitation', async () => {
    const invitation = await createInvitation({ expiresAt: new Date(Date.now() - 1000) });
    const response = await POST(
      acceptRequest(invitation.rawToken, { email: `expired-${Date.now()}@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(410);
  });

  it('rejects an already-used invitation', async () => {
    const invitation = await createInvitation({ usedAt: new Date() });
    const response = await POST(
      acceptRequest(invitation.rawToken, { email: `used-${Date.now()}@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(409);
  });

  it('rejects an unknown token', async () => {
    const token = `unknown-${randomBytes(8).toString('hex')}`;
    const response = await POST(
      acceptRequest(token, { email: `x-${Date.now()}@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }),
      { params: { token } },
    );
    expect(response.status).toBe(404);
  });

  it('renvoie 429 après 5 tentatives sur un jeton invalide depuis la même IP (issue #381)', async () => {
    const ip = randomBytes(8).toString('hex');
    const token = `invalid-probe-${randomBytes(8).toString('hex')}`;
    const db = await getDb();

    try {
      for (let i = 0; i < 5; i += 1) {
        const response = await POST(
          acceptRequest(token, { email: `probe-${i}@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }, ip),
          { params: { token } },
        );
        expect(response.status).toBe(404);
      }

      const blocked = await POST(
        acceptRequest(token, { email: `probe-blocked@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }, ip),
        { params: { token } },
      );
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBeTruthy();
    } finally {
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`invitation-accept:ip:${hashBucketComponent(ip)}`]);
      await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`invitation-accept:token:${hashBucketComponent(token)}`]);
    }
  });

  it("refuse la création de compte quand le club cible a été désactivé après l'envoi de l'invitation (issue #213)", async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const invitation = await createInvitation({ clubId, accessRole: 'admin', planningFunctions: [] });
    const db = await getDb();
    await db.getRepository('ClubTenant').save({ id: clubId, name: 'Club test désactivé', active: false });

    try {
      const email = `disabled-club-${randomBytes(8).toString('hex')}@example.com`;
      const response = await POST(
        acceptRequest(invitation.rawToken, { email, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }),
        { params: { token: invitation.rawToken } },
      );
      expect(response.status).toBe(404);
      expect(await db.getRepository('User').findOneBy({ email })).toBeNull();

      const unknownToken = `unknown-${randomBytes(8).toString('hex')}`;
      const unknownResponse = await POST(
        acceptRequest(unknownToken, { email: `y-${Date.now()}@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }),
        { params: { token: unknownToken } },
      );
      const body = await response.json();
      const unknownBody = await unknownResponse.json();
      expect(body.error).toBe(unknownBody.error);
    } finally {
      await db.getRepository('ClubTenant').delete({ id: clubId });
    }
  });
});

describe.skipIf(!dbAvailable)('POST /api/invitations/[token]/accept — activation d\'un profil sans accès (issue #204)', () => {
  const cleanupUserIds: number[] = [];
  const cleanupInvitationIds: string[] = [];

  afterEach(async () => {
    const db = await getDb();
    for (const id of cleanupUserIds) {
      await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :id', { id }).execute();
      await db.getRepository('User').delete({ id });
    }
    cleanupUserIds.length = 0;
    for (const id of cleanupInvitationIds) {
      await db.getRepository('Invitation').delete({ id });
    }
    cleanupInvitationIds.length = 0;
  });

  async function createUnclaimedProfile(clubId: string, nom: string, planningFunctions: string[]) {
    const db = await getDb();
    const profile = await db.getRepository<UserEntity>('User').save({
      clubId,
      email: `${randomBytes(6).toString('hex')}.officiel@sans-acces.local`,
      passwordHash: 'hash-inconnu',
      nom,
      accessRole: 'dirigeant',
      planningFunctions,
      active: true,
      claimedAt: null,
      icalToken: randomBytes(12).toString('hex'),
    });
    cleanupUserIds.push(profile.id);
    return profile;
  }

  it("n'interprète pas l'identifiant d'une ancienne cible métier comme un userId", async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const collidingProfile = await createUnclaimedProfile(clubId, 'Profil Collision', ['encadrant']);
    const invitation = await createInvitation({
      clubId,
      personType: 'officiel',
      personId: collidingProfile.id,
    });
    cleanupInvitationIds.push(invitation.id);

    const email = `legacy-${randomBytes(8).toString('hex')}@example.com`;
    cleanupUserIds.push((await (await getDb()).getRepository<UserEntity>('User').findOneBy({ email }))?.id ?? -1);
    const response = await POST(
      acceptRequest(invitation.rawToken, { email, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Nouvel Utilisateur' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(200);

    const db = await getDb();
    const untouched = await db.getRepository<UserEntity>('User').findOneBy({ id: collidingProfile.id });
    expect(untouched?.claimedAt).toBeNull();
    expect(untouched?.email).not.toBe(email);
    const created = await db.getRepository<UserEntity>('User').findOneBy({ email });
    expect(created?.id).not.toBe(collidingProfile.id);
    if (created) cleanupUserIds.push(created.id);
  });

  it('attache les identifiants au profil existant sans créer de second utilisateur', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const profile = await createUnclaimedProfile(clubId, 'Nadia Multi Fonctions', ['arbitre_club']);
    const invitation = await createInvitation({
      clubId,
      accessRole: 'dirigeant',
      planningFunctions: ['encadrant'],
      personNom: profile.nom,
      personType: 'user',
      personId: profile.id,
    });
    cleanupInvitationIds.push(invitation.id);

    const email = `claim-${randomBytes(8).toString('hex')}@example.com`;
    const response = await POST(acceptRequest(invitation.rawToken, { email, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Nadia Multi Fonctions' }), {
      params: { token: invitation.rawToken },
    });
    expect(response.status).toBe(200);
    expect(response.cookies.get('session_token')?.value).toBeTruthy();

    const db = await getDb();
    const reloaded = await db.getRepository<UserEntity>('User').findOneBy({ id: profile.id });
    // Même identifiant : affectations et historique rattachés à users.id sont préservés.
    expect(reloaded?.email).toBe(email);
    expect(reloaded?.claimedAt).not.toBeNull();
    expect(reloaded?.accessRole).toBe('dirigeant');
    // Fonctions conservées et complétées par celles de l'invitation.
    expect(reloaded?.planningFunctions).toEqual(['arbitre_club', 'encadrant']);

    // Aucun doublon : un seul utilisateur pour ce nom dans ce club.
    const sameName = await db.getRepository('User').find({ where: { clubId, nom: 'Nadia Multi Fonctions' } });
    expect(sameName).toHaveLength(1);

    const usedInvitation = await db.getRepository<InvitationEntity>('Invitation').findOneBy({ id: invitation.id });
    expect(usedInvitation?.usedByUserId).toBe(profile.id);
  });

  it('une invitation administrateur explicite active le profil en admin sans toucher ses fonctions', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const profile = await createUnclaimedProfile(clubId, 'Omar Admin', ['accompagnateur']);
    const invitation = await createInvitation({
      clubId,
      accessRole: 'admin',
      planningFunctions: [],
      personType: 'user',
      personId: profile.id,
    });
    cleanupInvitationIds.push(invitation.id);

    const email = `claim-admin-${randomBytes(8).toString('hex')}@example.com`;
    const response = await POST(acceptRequest(invitation.rawToken, { email, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'Omar Admin' }), {
      params: { token: invitation.rawToken },
    });
    expect(response.status).toBe(200);
    expect((await response.json()).redirectTo).toBe('/club');

    const reloaded = await (await getDb()).getRepository<UserEntity>('User').findOneBy({ id: profile.id });
    expect(reloaded?.accessRole).toBe('admin');
    expect(reloaded?.planningFunctions).toEqual(['accompagnateur']);
    expect(reloaded?.claimedAt).not.toBeNull();
  });

  it('refuse d\'activer deux fois le même profil', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const profile = await createUnclaimedProfile(clubId, 'Déjà Activé', ['encadrant']);
    await (await getDb()).getRepository('User').update({ id: profile.id }, { claimedAt: new Date() });
    const invitation = await createInvitation({ clubId, personType: 'user', personId: profile.id });
    cleanupInvitationIds.push(invitation.id);

    const response = await POST(
      acceptRequest(invitation.rawToken, { email: `x-${randomBytes(4).toString('hex')}@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(409);
  });

  it('renvoie 404 quand le profil ciblé a été supprimé entre-temps', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const invitation = await createInvitation({ clubId, personType: 'user', personId: 987654321 });
    cleanupInvitationIds.push(invitation.id);

    const response = await POST(
      acceptRequest(invitation.rawToken, { email: `y-${randomBytes(4).toString('hex')}@example.com`, password: 'password123', confirmIdentity: true, acknowledgeNotice: true, nom: 'X' }),
      { params: { token: invitation.rawToken } },
    );
    expect(response.status).toBe(404);
  });
});

afterAll(async () => {
  if (cleanupCreator) await cleanupCreator();
});
