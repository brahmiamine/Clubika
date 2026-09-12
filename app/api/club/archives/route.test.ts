import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { Match, MatchesData } from '@/types/match';
import { syncOfficialMatchesData } from '@/lib/db/json-migrator';
import { updateAppSettings } from '@/lib/settings-store';
import { GET as getArchives } from './route';
import { GET as getActiveMatches } from '@/app/api/matches/route';

const dbAvailable = await isDbAvailable();

function getRequest(path: string, token: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { cookie: `session_token=${token}` },
  });
}

function scraperData(matches: Match[], scrapedAt: string): MatchesData {
  const grouped: MatchesData['matches'] = {};
  for (const match of matches) {
    grouped[match.date] = [...(grouped[match.date] ?? []), match];
  }
  return {
    club: { name: 'Club test', description: '', logo: '' },
    url: 'https://example.test/matches',
    scrapedAt,
    matches: grouped,
  };
}

function official(overrides: Partial<Match> & Pick<Match, 'id' | 'date'>): Match {
  return {
    type: 'officiel',
    time: '15:00',
    competition: 'Championnat',
    localTeam: 'AFP',
    awayTeam: 'Visiteur',
    venue: 'domicile',
    horaireRendezVous: '14:00',
    ...overrides,
  };
}

describe.skipIf(!dbAvailable)('GET /api/club/archives (issue #319)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('archive un match disparu après deux absences, le masque du listing actif, puis le retire à la réapparition', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const otherClubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const otherAdmin = await createTestUserAndSession('admin', { clubId: otherClubId });
    const dirigeant = await createTestUserAndSession('dirigeant', { clubId });
    const db = await getDb();
    await Promise.all([clubId, otherClubId].map((id) => updateAppSettings(db, id, (current) => ({
      ...current,
      features: { ...current.features, officialMatchesCurrentWeekendOnly: false },
    }))));

    const keepId = `keep-${randomBytes(4).toString('hex')}`;
    const goneId = `gone-${randomBytes(4).toString('hex')}`;
    const otherId = `other-${randomBytes(4).toString('hex')}`;
    const keep = official({ id: keepId, date: '20/10/2026', awayTeam: 'Gardien' });
    const gone = official({ id: goneId, date: '21/10/2026', awayTeam: 'Disparu FC' });
    const otherClubMatch = official({ id: otherId, date: '01/08/2026', competition: 'Club B', awayTeam: 'Secret' });

    cleanups.push(async () => {
      await db.getRepository('MatchOfficial').delete({ clubId });
      await db.getRepository('MatchExtra').delete({ clubId });
      await db.getRepository('MatchOfficial').delete({ clubId: otherClubId });
      await db.getRepository('MatchExtra').delete({ clubId: otherClubId });
      await admin.cleanup();
      await otherAdmin.cleanup();
      await dirigeant.cleanup();
    });

    await syncOfficialMatchesData(db, scraperData([keep, gone], '2026-09-01T08:00:00.000Z'), clubId);
    await syncOfficialMatchesData(db, scraperData([otherClubMatch], '2026-09-01T08:00:00.000Z'), otherClubId);

    const forbidden = await getArchives(getRequest('/api/club/archives', dirigeant.token));
    expect(forbidden.status).toBe(403);

    await syncOfficialMatchesData(db, scraperData([keep], '2026-09-02T08:00:00.000Z'), clubId);
    const afterFirstMiss = await getActiveMatches(getRequest('/api/matches', admin.token));
    const firstBody = await afterFirstMiss.json() as { matches: Record<string, Array<{ id?: string }>> };
    const firstIds = Object.values(firstBody.matches).flat().map((item) => item.id);
    expect(firstIds).toContain(goneId);

    const archivesPending = await getArchives(getRequest('/api/club/archives', admin.token));
    const pendingBody = await archivesPending.json() as { items: Array<{ id: string }> };
    expect(pendingBody.items.some((item) => item.id === goneId)).toBe(false);

    await syncOfficialMatchesData(db, scraperData([keep], '2026-09-03T08:00:00.000Z'), clubId);

    const activeAfterConfirm = await getActiveMatches(getRequest('/api/matches', admin.token));
    const activeBody = await activeAfterConfirm.json() as { matches: Record<string, Array<{ id?: string }>> };
    expect(Object.values(activeBody.matches).flat().map((item) => item.id)).not.toContain(goneId);

    const archives = await getArchives(getRequest('/api/club/archives', admin.token));
    expect(archives.status).toBe(200);
    const archived = await archives.json() as { items: Array<{ id: string; badges: string[]; awayTeam: string }> };
    const goneRow = archived.items.find((item) => item.id === goneId);
    expect(goneRow).toMatchObject({ awayTeam: 'Disparu FC' });
    expect(goneRow?.badges).toContain('missing');
    expect(archived.items.some((item) => item.id === otherId)).toBe(false);

    const otherArchives = await getArchives(getRequest('/api/club/archives', otherAdmin.token));
    const otherBody = await otherArchives.json() as { items: Array<{ id: string }> };
    expect(otherBody.items.some((item) => item.id === goneId)).toBe(false);
    expect(otherBody.items.some((item) => item.id === otherId)).toBe(true);

    await syncOfficialMatchesData(db, scraperData([keep, gone], '2026-09-04T08:00:00.000Z'), clubId);
    const restoredActive = await getActiveMatches(getRequest('/api/matches', admin.token));
    const restoredIds = Object.values((await restoredActive.json() as { matches: Record<string, Array<{ id?: string }>> }).matches).flat().map((item) => item.id);
    expect(restoredIds).toContain(goneId);

    const archivesRestored = await getArchives(getRequest('/api/club/archives', admin.token));
    const restoredArchive = await archivesRestored.json() as { items: Array<{ id: string; badges: string[] }> };
    const restoredRow = restoredArchive.items.find((item) => item.id === goneId);
    expect(restoredRow?.badges.includes('missing') ?? false).toBe(false);
  });
});
