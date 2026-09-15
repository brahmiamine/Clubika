import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { InvitationEntity } from '@/lib/db/schemas';
import { hashInvitationToken, maskEmail } from '@/lib/auth/invitation-tokens';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import { INVITATION_CONTEXT_COOKIE } from '@/lib/auth/constants';
import { GET, DELETE } from './route';
import { GET as getContext } from '../context/route';
import { DEFAULT_APP_SETTINGS } from '@/lib/settings';
import { saveAppSettings } from '@/lib/settings-store';

const dbAvailable = await isDbAvailable();

function getRequest(token: string, ip = randomBytes(8).toString('hex')) {
  return new NextRequest(`http://localhost/api/invitations/${token}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

function contextRequest(contextToken: string, ip = randomBytes(8).toString('hex')) {
  return new NextRequest('http://localhost/api/invitations/context', {
    headers: {
      'x-forwarded-for': ip,
      cookie: `${INVITATION_CONTEXT_COOKIE}=${contextToken}`,
    },
  });
}

function deleteRequest(token: string, sessionToken: string) {
  return new NextRequest(`http://localhost/api/invitations/${token}`, {
    method: 'DELETE',
    headers: { cookie: `session_token=${sessionToken}` },
  });
}

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
    personNom: 'Personne Invitee',
    personType: null,
    personId: null,
    createdByUserId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    usedAt: null,
    usedByUserId: null,
    createdAt: new Date(),
    validationContextHash: null,
    validationContextExpiresAt: null,
    ...overrides,
  };
  await repo.save(invitation);
  return { ...invitation, rawToken };
}

async function cleanupRateLimit(ip: string, token: string) {
  const db = await getDb();
  await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`invitation-validate:ip:${hashBucketComponent(ip)}`]);
  await db.query('DELETE FROM login_rate_limits WHERE bucket_key = ?', [`invitation-validate:token:${hashBucketComponent(token)}`]);
}

describe.skipIf(!dbAvailable)('GET/DELETE /api/invitations/[token] (issue #34)', () => {
  it('reports an unknown token as invalid without authentication', async () => {
    const token = 'unknown-token';
    const ip = randomBytes(8).toString('hex');
    try {
      const response = await GET(getRequest(token, ip), { params: { token } });
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body).toEqual({ valid: false });
      expect(response.headers.get('Cache-Control')).toMatch(/no-store/);
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(JSON.stringify(body)).not.toContain(token);
    } finally {
      await cleanupRateLimit(ip, token);
    }
  });

  it('valide une invitation live sans révéler email, rôle, nom ni branding', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const live = await makeInvitation(clubId, admin.user.id);
    const used = await makeInvitation(clubId, admin.user.id, { usedAt: new Date() });
    const expired = await makeInvitation(clubId, admin.user.id, { expiresAt: new Date(Date.now() - 1000) });
    const ip = randomBytes(8).toString('hex');

    try {
      const liveResponse = await GET(getRequest(live.rawToken, ip), { params: { token: live.rawToken } });
      expect(liveResponse.status).toBe(200);
      const liveBody = await liveResponse.json() as Record<string, unknown>;
      expect(liveBody).toEqual({
        valid: true,
        emailMasked: maskEmail(live.email),
        clubName: expect.any(String),
      });
      expect(liveBody.email).toBeUndefined();
      expect(liveBody.accessRole).toBeUndefined();
      expect(liveBody.planningFunctions).toBeUndefined();
      expect(liveBody.personNom).toBeUndefined();
      expect(liveBody.club).toBeUndefined();
      expect(JSON.stringify(liveBody)).not.toContain('invite@example.com');
      expect(JSON.stringify(liveBody)).not.toContain(live.rawToken);
      expect(JSON.stringify(liveBody)).not.toContain('Personne Invitee');
      expect(liveResponse.headers.get('Cache-Control')).toMatch(/no-store/);
      expect(liveResponse.headers.get('Referrer-Policy')).toBe('no-referrer');
      expect(liveResponse.cookies.get(INVITATION_CONTEXT_COOKIE)?.value).toMatch(/^[a-f0-9]{64}$/);

      const usedResponse = await GET(getRequest(used.rawToken, ip), { params: { token: used.rawToken } });
      const expiredResponse = await GET(getRequest(expired.rawToken, ip), { params: { token: expired.rawToken } });
      const unknownToken = `unknown-${randomBytes(8).toString('hex')}`;
      const unknownResponse = await GET(getRequest(unknownToken, ip), { params: { token: unknownToken } });

      expect(usedResponse.status).toBe(404);
      expect(expiredResponse.status).toBe(404);
      expect(unknownResponse.status).toBe(404);
      expect(await usedResponse.json()).toEqual({ valid: false });
      expect(await expiredResponse.json()).toEqual({ valid: false });
      expect(await unknownResponse.json()).toEqual({ valid: false });
    } finally {
      const db = await getDb();
      await db.getRepository('Invitation').delete({ id: live.id });
      await db.getRepository('Invitation').delete({ id: used.id });
      await db.getRepository('Invitation').delete({ id: expired.id });
      await cleanupRateLimit(ip, live.rawToken);
      await cleanupRateLimit(ip, used.rawToken);
      await cleanupRateLimit(ip, expired.rawToken);
      await admin.cleanup();
    }
  });

  it('n’expose que le nom public du club, pas le logo ni les couleurs', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const live = await makeInvitation(clubId, admin.user.id);
    const db = await getDb();
    const ip = randomBytes(8).toString('hex');

    try {
      await saveAppSettings(db, clubId, {
        ...DEFAULT_APP_SETTINGS,
        clubName: 'Club Public Test',
        clubLogo: 'https://cdn.example/blason.png',
        primaryColor: '#c8102e',
        accentColor: '#f4e4c1',
      });

      const response = await GET(getRequest(live.rawToken, ip), { params: { token: live.rawToken } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({
        valid: true,
        emailMasked: maskEmail(live.email),
        clubName: 'Club Public Test',
      });
      expect(JSON.stringify(body)).not.toContain('cdn.example');
      expect(JSON.stringify(body)).not.toContain('#c8102e');
    } finally {
      await db.getRepository('Invitation').delete({ id: live.id });
      await db.getRepository('ClubTenant').delete({ id: clubId });
      await cleanupRateLimit(ip, live.rawToken);
      await admin.cleanup();
    }
  });

  it('échange le jeton d’URL contre un contexte cookie relisible sans le secret', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const live = await makeInvitation(clubId, admin.user.id);
    const ip = randomBytes(8).toString('hex');

    try {
      const exchange = await GET(getRequest(live.rawToken, ip), { params: { token: live.rawToken } });
      const contextToken = exchange.cookies.get(INVITATION_CONTEXT_COOKIE)?.value;
      expect(contextToken).toBeTruthy();

      const contextResponse = await getContext(contextRequest(contextToken!, ip));
      expect(contextResponse.status).toBe(200);
      const contextBody = await contextResponse.json();
      expect(contextBody).toMatchObject({
        valid: true,
        emailMasked: maskEmail(live.email),
      });
      expect(JSON.stringify(contextBody)).not.toContain(live.rawToken);
    } finally {
      const db = await getDb();
      await db.getRepository('Invitation').delete({ id: live.id });
      await cleanupRateLimit(ip, live.rawToken);
      await admin.cleanup();
    }
  });

  it('ne révèle pas une invitation d’un autre tenant via un jeton expiré ou inconnu', async () => {
    const clubA = `test-club-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId: clubA });
    const adminB = await createTestUserAndSession('admin', { clubId: clubB });
    const otherExpired = await makeInvitation(clubB, adminB.user.id, { expiresAt: new Date(Date.now() - 1000) });
    const ip = randomBytes(8).toString('hex');

    try {
      const response = await GET(getRequest(otherExpired.rawToken, ip), { params: { token: otherExpired.rawToken } });
      const unknown = `unknown-${randomBytes(8).toString('hex')}`;
      const unknownResponse = await GET(getRequest(unknown, ip), { params: { token: unknown } });
      const expiredBody = await response.json();
      const unknownBody = await unknownResponse.json();
      expect(response.status).toBe(unknownResponse.status);
      expect(expiredBody).toEqual(unknownBody);
      expect(JSON.stringify(expiredBody)).not.toContain(clubB);
    } finally {
      const db = await getDb();
      await db.getRepository('Invitation').delete({ id: otherExpired.id });
      await cleanupRateLimit(ip, otherExpired.rawToken);
      await adminA.cleanup();
      await adminB.cleanup();
    }
  });

  it('renvoie 429 après 5 sondes GET sur un jeton invalide depuis la même IP', async () => {
    const ip = randomBytes(8).toString('hex');
    const token = `invalid-probe-${randomBytes(8).toString('hex')}`;
    try {
      for (let i = 0; i < 5; i += 1) {
        const response = await GET(getRequest(token, ip), { params: { token } });
        expect(response.status).toBe(404);
      }
      const blocked = await GET(getRequest(token, ip), { params: { token } });
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBeTruthy();
    } finally {
      await cleanupRateLimit(ip, token);
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
