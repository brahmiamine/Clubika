import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { InvitationEntity, UserEntity } from '@/lib/db/schemas';
import { hashInvitationToken } from '@/lib/auth/invitation-tokens';
import { GET, POST } from './route';

const dbAvailable = await isDbAvailable();

function getRequest(url: string, token: string) {
  return new NextRequest(url, { headers: { cookie: `session_token=${token}` } });
}

function postRequest(body: Record<string, unknown>, token: string) {
  return new NextRequest('http://localhost/api/invitations', {
    method: 'POST',
    headers: { cookie: `session_token=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function markProfileClaimed(userId: number) {
  const db = await getDb();
  await db.getRepository('User').update({ id: userId }, { claimedAt: new Date() });
}

describe.skipIf(!dbAvailable)('GET/POST /api/invitations (issue #155)', () => {
  it('rejects non-admin access and an invalid role', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const encadrant = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    const admin = await createTestUserAndSession('admin', { clubId });
    try {
      const getResponse = await GET(getRequest('http://localhost/api/invitations', encadrant.token));
      expect(getResponse.status).toBe(403);

      const postResponse = await POST(postRequest({ email: 'nouveau@example.com', accessRole: 'dirigeant' }, encadrant.token));
      expect(postResponse.status).toBe(403);

      const invalidRole = await POST(postRequest({ email: 'nouveau@example.com', accessRole: 'superadmin' }, admin.token));
      expect(invalidRole.status).toBe(400);
    } finally {
      await encadrant.cleanup();
      await admin.cleanup();
    }
  });

  it('refuse une invitation administrateur sans email lié (issue #271)', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    try {
      const withoutEmail = await POST(postRequest({ accessRole: 'admin' }, admin.token));
      expect(withoutEmail.status).toBe(400);

      const blankEmail = await POST(postRequest({ accessRole: 'admin', email: '   ' }, admin.token));
      expect(blankEmail.status).toBe(400);
    } finally {
      await admin.cleanup();
    }
  });

  it('creates an invitation scoped to the admin club and lists only that club’s invitations', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const otherClubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const otherAdmin = await createTestUserAndSession('admin', { clubId: otherClubId });
    let invitationId: string | null = null;

    try {
      const db = await getDb();

      const createResponse = await POST(postRequest({
        email: 'Nouveau.Encadrant@Example.com',
        accessRole: 'dirigeant',
        planningFunctions: ['encadrant'],
        personNom: 'Nouveau Encadrant',
        expiresInDays: 3,
      }, admin.token));
      expect(createResponse.status).toBe(200);
      const createBody = await createResponse.json();
      invitationId = createBody.invitation.id as string;
      // L'email est normalisé (minuscules) avant stockage.
      expect(createBody.invitation.email).toBe('nouveau.encadrant@example.com');
      // Le jeton brut de l'URL n'est jamais stocké tel quel : seule son empreinte
      // SHA-256 l'est, comme `id` (issue #271).
      const rawToken = String(createBody.url).split('/inscription/').pop() ?? '';
      expect(createBody.url).toMatch(/\/inscription\/[a-f0-9]+$/);
      expect(rawToken).not.toBe(invitationId);
      expect(hashInvitationToken(rawToken)).toBe(invitationId);

      const stored = await db.getRepository<InvitationEntity>('Invitation').findOneBy({ id: invitationId });
      expect(stored?.clubId).toBe(clubId);

      const adminList = await GET(getRequest('http://localhost/api/invitations', admin.token));
      const adminBody = await adminList.json();
      expect(adminBody.invitations.some((inv: { id: string }) => inv.id === invitationId)).toBe(true);

      // L'admin d'un autre club ne voit pas cette invitation (frontière multi-tenant).
      const otherList = await GET(getRequest('http://localhost/api/invitations', otherAdmin.token));
      const otherBody = await otherList.json();
      expect(otherBody.invitations.some((inv: { id: string }) => inv.id === invitationId)).toBe(false);
    } finally {
      const db = await getDb();
      if (invitationId) await db.getRepository('Invitation').delete({ id: invitationId });
      await admin.cleanup();
      await otherAdmin.cleanup();
    }
  });
});

describe.skipIf(!dbAvailable)('POST /api/invitations — ciblage d\'un profil sans accès (issue #204)', () => {
  async function createUnclaimedProfile(clubId: string, nom: string, planningFunctions: string[] = ['encadrant']) {
    const db = await getDb();
    return db.getRepository<UserEntity>('User').save({
      clubId,
      email: `${nom.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.')}.${randomBytes(3).toString('hex')}@sans-acces.local`,
      passwordHash: 'hash-inconnu',
      nom,
      accessRole: 'dirigeant',
      planningFunctions,
      active: true,
      claimedAt: null,
      icalToken: randomBytes(12).toString('hex'),
    });
  }

  async function cleanup(ids: { users?: number[]; invitations?: string[] }) {
    const db = await getDb();
    for (const id of ids.invitations ?? []) await db.getRepository('Invitation').delete({ id });
    for (const id of ids.users ?? []) await db.getRepository('User').delete({ id });
  }

  it('lie l\'invitation au profil existant via personId, en reprenant ses fonctions par défaut', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const profile = await createUnclaimedProfile(clubId, 'Nadia Arbitre');
    let invitationId: string | null = null;
    try {
      const response = await POST(postRequest({ accessRole: 'dirigeant', personId: profile.id }, admin.token));
      expect(response.status).toBe(200);
      const body = await response.json();
      invitationId = body.invitation.id;
      expect(body.invitation.personId).toBe(profile.id);
      expect(body.invitation.personType).toBe('user');
      expect(body.invitation.personNom).toBe('Nadia Arbitre');
      // Fonctions du profil reprises quand l'invitation n'en précise pas.
      expect(body.invitation.planningFunctions).toEqual(['encadrant']);
    } finally {
      await cleanup({ users: [profile.id], invitations: invitationId ? [invitationId] : [] });
      await admin.cleanup();
    }
  });

  it('refuse de cibler un compte déjà activé ou de créer une seconde invitation en attente', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const profile = await createUnclaimedProfile(clubId, 'Karim Encadrant');
    let invitationId: string | null = null;
    try {
      const first = await POST(postRequest({ accessRole: 'dirigeant', personId: profile.id }, admin.token));
      expect(first.status).toBe(200);
      invitationId = (await first.json()).invitation.id;

      const duplicate = await POST(postRequest({ accessRole: 'dirigeant', personId: profile.id }, admin.token));
      expect(duplicate.status).toBe(409);

      // Un compte déjà activé n'a rien à faire derrière une invitation.
      await markProfileClaimed(profile.id);
      const claimed = await POST(postRequest({ accessRole: 'dirigeant', personId: profile.id }, admin.token));
      expect(claimed.status).toBe(409);
    } finally {
      await cleanup({ users: [profile.id], invitations: invitationId ? [invitationId] : [] });
      await admin.cleanup();
    }
  });

  it('ne cible pas un profil inactif résolu par son nom', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const profile = await createUnclaimedProfile(clubId, 'Profil Inactif');
    const invitationIds: string[] = [];
    try {
      await (await getDb()).getRepository('User').update({ id: profile.id }, { active: false });
      const response = await POST(postRequest({
        accessRole: 'dirigeant',
        personNom: 'Profil Inactif',
      }, admin.token));
      expect(response.status).toBe(200);
      const body = await response.json();
      invitationIds.push(body.invitation.id);
      expect(body.invitation.personId).toBeNull();
      expect(body.invitation.personType).toBeNull();
    } finally {
      await cleanup({ users: [profile.id], invitations: invitationIds });
      await admin.cleanup();
    }
  });

  it('résout personNom uniquement s\'il désigne un seul profil sans accès (homonymes refusés)', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const unique = await createUnclaimedProfile(clubId, 'Unique Accompagnateur');
    const twinA = await createUnclaimedProfile(clubId, 'Jumeau Commun');
    const twinB = await createUnclaimedProfile(clubId, 'Jumeau Commun');
    const invitationIds: string[] = [];
    try {
      const resolved = await POST(postRequest({ accessRole: 'dirigeant', personNom: 'Unique Accompagnateur' }, admin.token));
      expect(resolved.status).toBe(200);
      const resolvedBody = await resolved.json();
      invitationIds.push(resolvedBody.invitation.id);
      expect(resolvedBody.invitation.personId).toBe(unique.id);

      const ambiguous = await POST(postRequest({ accessRole: 'dirigeant', personNom: 'Jumeau Commun' }, admin.token));
      expect(ambiguous.status).toBe(400);

      // Nom inconnu : simple libellé d'affichage, aucun rapprochement forcé.
      const label = await POST(postRequest({ accessRole: 'dirigeant', personNom: 'Inconnu Personne' }, admin.token));
      expect(label.status).toBe(200);
      const labelBody = await label.json();
      invitationIds.push(labelBody.invitation.id);
      expect(labelBody.invitation.personId).toBeNull();
      expect(labelBody.invitation.personNom).toBe('Inconnu Personne');
    } finally {
      await cleanup({ users: [unique.id, twinA.id, twinB.id], invitations: invitationIds });
      await admin.cleanup();
    }
  });
});
