import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession, enableTrustedProxyHeaders, uniqueTestIp } from '@/lib/auth/test-helpers';
import { hashBucketComponent } from '@/lib/auth/login-rate-limit';
import type { MatchAmicalEntity, MatchExtraEntity } from '@/lib/db/schemas';
import { GET } from './route';

const dbAvailable = await isDbAvailable();

function icalRequest(token: string, ip = uniqueTestIp()) {
  return new NextRequest(`http://localhost/api/ical/${token}`, {
    headers: { 'x-forwarded-for': ip },
  });
}

async function saveAmicalMatch(
  db: Awaited<ReturnType<typeof getDb>>,
  clubId: string,
  id: string,
  payload: Record<string, unknown>,
) {
  await db.getRepository<MatchAmicalEntity>('MatchAmical').save({
    clubId,
    id,
    date: (payload.date as string) ?? '20/01/2027',
    time: (payload.time as string) ?? '10:00',
    payload: { id, type: 'amical', ...payload },
  });
}

async function saveMatchExtras(
  db: Awaited<ReturnType<typeof getDb>>,
  clubId: string,
  matchId: string,
  payload: Record<string, unknown>,
) {
  await db.getRepository<MatchExtraEntity>('MatchExtra').save({
    clubId,
    matchId,
    payload: { id: matchId, ...payload },
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

describe.skipIf(!dbAvailable)('GET /api/ical/[token] — minimisation des données personnelles (issue #13)', () => {
  it("n'expose dans DESCRIPTION ni les noms des autres personnes assignées, ni l'adresse libre du match (fuite de données)", async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const { user, cleanup } = await createTestUserAndSession('dirigeant', { clubId, nom: 'Abonné Sentinelle' }, ['arbitre_club']);
    const db = await getDb();
    const matchId = `match-${randomBytes(6).toString('hex')}`;

    try {
      await saveAmicalMatch(db, clubId, matchId, {
        date: '20/01/2027',
        time: '10:00',
        competition: 'Amical',
        localTeam: 'Equipe Sentinelle A',
        awayTeam: 'Equipe Sentinelle B',
        venue: 'domicile',
        details: { address: '26 Rue Sentinelle, 75000 Villefictive', stadium: 'Stade Sentinelle' },
      });
      await saveMatchExtras(db, clubId, matchId, {
        arbitreTouche: [
          { nom: 'Abonné Sentinelle', numero: '', personId: user.id, personType: 'officiel', status: 'accepted' },
          { nom: 'Autre Arbitre Sentinel', numero: '', personId: user.id + 1, personType: 'officiel', status: 'accepted' },
        ],
        contactEncadrants: [{ nom: 'Autre Encadrant Sentinel', numero: '' }],
        contactAccompagnateur: [{ nom: 'Autre Accompagnateur Sentinel', numero: '' }],
      });

      const response = await GET(icalRequest(user.icalToken) as never, { params: { token: user.icalToken } });
      expect(response.status).toBe(200);
      const ics = (await response.text()).replace(/\r\n /g, '');

      expect(ics).toContain('Abonné Sentinelle');
      expect(ics).not.toContain('Autre Arbitre Sentinel');
      expect(ics).not.toContain('Autre Encadrant Sentinel');
      expect(ics).not.toContain('Autre Accompagnateur Sentinel');
      expect(ics).not.toContain('Adresse:');
      expect(ics).not.toContain('26 Rue Sentinelle');
      expect(ics).toContain('LOCATION:Stade Sentinelle');
    } finally {
      await db.getRepository('MatchExtra').delete({ clubId, matchId });
      await db.getRepository('MatchAmical').delete({ clubId, id: matchId });
      await cleanup();
    }
  });
});

describe.skipIf(!dbAvailable)('GET /api/ical/[token] — isolation inter-clubs (issue #13)', () => {
  it("le flux d'un abonné ne contient que les événements de son propre club, même en cas d'id d'événement partagé", async () => {
    const clubA = `test-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-b-${randomBytes(6).toString('hex')}`;
    const sharedEventId = `shared-${randomBytes(6).toString('hex')}`;
    const userA = await createTestUserAndSession('dirigeant', { clubId: clubA, nom: 'Abonné Club A' }, ['arbitre_club']);
    const userB = await createTestUserAndSession('dirigeant', { clubId: clubB, nom: 'Abonné Club B' }, ['arbitre_club']);
    const db = await getDb();

    try {
      await saveAmicalMatch(db, clubA, sharedEventId, {
        date: '20/01/2027', time: '10:00', competition: 'Amical', localTeam: 'Club A Domicile', awayTeam: 'Club A Extérieur', venue: 'domicile',
      });
      await saveMatchExtras(db, clubA, sharedEventId, {
        arbitreTouche: [{ nom: 'Abonné Club A', numero: '', personId: userA.user.id, personType: 'officiel', status: 'accepted' }],
      });
      await saveAmicalMatch(db, clubB, sharedEventId, {
        date: '20/01/2027', time: '10:00', competition: 'Amical', localTeam: 'Club B Domicile', awayTeam: 'Club B Extérieur', venue: 'domicile',
      });
      await saveMatchExtras(db, clubB, sharedEventId, {
        arbitreTouche: [{ nom: 'Abonné Club B', numero: '', personId: userB.user.id, personType: 'officiel', status: 'accepted' }],
      });

      const responseA = await GET(icalRequest(userA.user.icalToken) as never, { params: { token: userA.user.icalToken } });
      expect(responseA.status).toBe(200);
      const icsA = await responseA.text();
      expect(icsA).toContain('Club A Domicile');
      expect(icsA).not.toContain('Club B Domicile');
      expect(icsA).toContain(`amical-${sharedEventId}@${clubA}.clubika`);
      expect(icsA).not.toContain(`amical-${sharedEventId}@${clubB}.clubika`);

      const responseB = await GET(icalRequest(userB.user.icalToken) as never, { params: { token: userB.user.icalToken } });
      expect(responseB.status).toBe(200);
      const icsB = await responseB.text();
      expect(icsB).toContain('Club B Domicile');
      expect(icsB).not.toContain('Club A Domicile');
    } finally {
      await db.getRepository('MatchExtra').delete({ clubId: clubA, matchId: sharedEventId });
      await db.getRepository('MatchExtra').delete({ clubId: clubB, matchId: sharedEventId });
      await db.getRepository('MatchAmical').delete({ clubId: clubA, id: sharedEventId });
      await db.getRepository('MatchAmical').delete({ clubId: clubB, id: sharedEventId });
      await userA.cleanup();
      await userB.cleanup();
    }
  });
});
