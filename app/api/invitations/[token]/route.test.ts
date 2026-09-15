import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { InvitationEntity } from '@/lib/db/schemas';
import { hashInvitationToken } from '@/lib/auth/invitation-tokens';
import { GET, DELETE } from './route';
import { DEFAULT_APP_SETTINGS } from '@/lib/settings';
import { saveAppSettings } from '@/lib/settings-store';

const dbAvailable = await isDbAvailable();

function getRequest(token: string) {
  return new NextRequest(`http://localhost/api/invitations/${token}`);
}

function deleteRequest(token: string, sessionToken: string) {
  return new NextRequest(`http://localhost/api/invitations/${token}`, {
    method: 'DELETE',
    headers: { cookie: `session_token=${sessionToken}` },
  });
}

// Seule l'empreinte du jeton est stockée en base (issue #271) : `id` reste
// l'empreinte réellement persistée, `rawToken` est le jeton brut à utiliser dans
// les requêtes publiques (GET), comme un vrai lien d'invitation.
async function makeInvitation(clubId: string, createdByUserId: number, overrides?: Partial<InvitationEntity>) {
  const db = await getDb();
  const repo = db.getRepository<InvitationEntity>('Invitation');
  const rawToken = randomBytes(12).toString('hex');
  const invitation: InvitationEntity = {
    id: hashInvitationToken(rawToken),
    clubId,
    email: 'invite@example.com',
    pendingEmailKey: null,
    accessRole: 'dirigeant',
    planningFunctions: ['encadrant'],
    personNom: null,
    personType: null,
    personId: null,
    createdByUserId,
    createdByPlatformAdminId: null,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    usedAt: null,
    usedByUserId: null,
    createdAt: new Date(),
    ...overrides,
  };
  await repo.save(invitation);
  return { ...invitation, rawToken };
}

describe.skipIf(!dbAvailable)('GET/DELETE /api/invitations/[token] (issue #155)', () => {
  it('reports an unknown token as invalid without authentication', async () => {
    const response = await GET(getRequest('unknown-token'), { params: { token: 'unknown-token' } });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.valid).toBe(false);
  });

  it('validates a live invitation and rejects a used or expired one', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const live = await makeInvitation(clubId, admin.user.id);
    const used = await makeInvitation(clubId, admin.user.id, { usedAt: new Date() });
    const expired = await makeInvitation(clubId, admin.user.id, { expiresAt: new Date(Date.now() - 1000) });

    try {
      const liveResponse = await GET(getRequest(live.rawToken), { params: { token: live.rawToken } });
      expect(liveResponse.status).toBe(200);
      const liveBody = await liveResponse.json();
      expect(liveBody).toMatchObject({
        valid: true,
        email: live.email,
        accessRole: 'dirigeant',
        planningFunctions: ['encadrant'],
        club: {
          name: expect.any(String),
          logo: expect.any(String),
          primaryColor: expect.stringMatching(/^#/),
          accentColor: expect.stringMatching(/^#/),
        },
      });

      const usedResponse = await GET(getRequest(used.rawToken), { params: { token: used.rawToken } });
      expect(usedResponse.status).toBe(410);

      const expiredResponse = await GET(getRequest(expired.rawToken), { params: { token: expired.rawToken } });
      expect(expiredResponse.status).toBe(410);
    } finally {
      const db = await getDb();
      await db.getRepository('Invitation').delete({ id: live.id });
      await db.getRepository('Invitation').delete({ id: used.id });
      await db.getRepository('Invitation').delete({ id: expired.id });
      await admin.cleanup();
    }
  });

  it('expose le logo et les couleurs du club invité', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const live = await makeInvitation(clubId, admin.user.id);
    const db = await getDb();

    try {
      await saveAppSettings(db, clubId, {
        ...DEFAULT_APP_SETTINGS,
        clubName: 'Salesienne de Paris',
        clubLogo: 'https://cdn.example/blason.png',
        primaryColor: '#c8102e',
        accentColor: '#f4e4c1',
      });

      const response = await GET(getRequest(live.rawToken), { params: { token: live.rawToken } });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        valid: true,
        club: {
          name: 'Salesienne de Paris',
          logo: 'https://cdn.example/blason.png',
          primaryColor: '#c8102e',
          accentColor: '#f4e4c1',
        },
      });
    } finally {
      await db.getRepository('Invitation').delete({ id: live.id });
      await db.getRepository('ClubTenant').delete({ id: clubId });
      await admin.cleanup();
    }
  });

  it('lets an admin revoke an invitation from their own club but not from another club', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const otherClubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const otherAdmin = await createTestUserAndSession('admin', { clubId: otherClubId });
    const invitation = await makeInvitation(clubId, admin.user.id);

    try {
      const forbiddenCrossClub = await DELETE(deleteRequest(invitation.rawToken, otherAdmin.token), { params: { token: invitation.rawToken } });
      expect(forbiddenCrossClub.status).toBe(404);

      const response = await DELETE(deleteRequest(invitation.rawToken, admin.token), { params: { token: invitation.rawToken } });
      expect(response.status).toBe(200);

      const db = await getDb();
      const stillThere = await db.getRepository<InvitationEntity>('Invitation').findOneBy({ id: invitation.id });
      expect(stillThere).toBeNull();
    } finally {
      const db = await getDb();
      await db.getRepository('Invitation').delete({ id: invitation.id });
      await admin.cleanup();
      await otherAdmin.cleanup();
    }
  });

  it('revokes an invitation when DELETE uses the hashed id returned by the admin list (issue #378)', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const invitation = await makeInvitation(clubId, admin.user.id);

    try {
      const response = await DELETE(deleteRequest(invitation.id, admin.token), { params: { token: invitation.id } });
      expect(response.status).toBe(200);

      const db = await getDb();
      const stillThere = await db.getRepository<InvitationEntity>('Invitation').findOneBy({ id: invitation.id });
      expect(stillThere).toBeNull();
    } finally {
      const db = await getDb();
      await db.getRepository('Invitation').delete({ id: invitation.id });
      await admin.cleanup();
    }
  });
});
