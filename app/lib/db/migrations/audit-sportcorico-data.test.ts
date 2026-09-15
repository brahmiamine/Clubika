import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import type { AppMetaEntity, MatchExtraEntity, MatchOfficialEntity } from '@/lib/db/schemas';
import { serializeMatchExtrasPayload, serializeMatchPayload } from '@/lib/db/planning-payload-codecs';
import type { Match } from '@/types/match';
import { auditSportCoricoData } from './audit-sportcorico-data';

const dbAvailable = await isDbAvailable();

function scMatch(id: string): Match {
  return {
    id,
    type: 'officiel',
    date: '01/09/2026',
    time: '15:00',
    competition: 'Championnat',
    localTeam: 'Equipe A',
    awayTeam: 'Equipe B',
    venue: 'domicile',
    horaireRendezVous: '14:00',
    sourceMatchId: `sc-${id}`,
    sourceStatus: 'active',
    url: 'https://www.sportcorico.com/match/demo',
    localTeamLogo: 'https://api.sportcorico.com/logos/a.png',
    details: {
      stadium: 'Stade X',
      dateTime: '01/09/2026 - 15:00',
      competition: 'Championnat',
      address: '1 rue',
      terrainType: 'Synthétique',
      itineraryLink: '',
      rawText: '{"source":"sportcorico-api"}',
    },
    staff: { referee: 'Arbitre Test', assistant1: '', assistant2: '', rawText: 'staff' },
  };
}

function manualMatch(id: string): Match {
  return {
    id,
    type: 'officiel',
    date: '02/09/2026',
    time: '11:00',
    competition: 'Championnat',
    localTeam: 'Club B',
    awayTeam: 'Visiteur',
    venue: 'domicile',
    horaireRendezVous: '10:00',
    sourceStatus: 'active',
    importProvenance: { provider: 'manual', rightsAttested: true },
  };
}

describe.skipIf(!dbAvailable)('migration 0027 — audit / quarantaine SportCorico (issue #5)', () => {
  it('inventorie en dry-run sans écrire, applique de façon idempotente et isole les clubs', async () => {
    const db = await getDb();
    const tag = randomBytes(6).toString('hex');
    const clubA = `test-sc-a-${tag}`;
    const clubB = `test-sc-b-${tag}`;
    const idA = `official-a-${tag}`;
    const idB = `official-b-${tag}`;
    const publishedId = `published-planning:${clubA}`;
    const officialRepo = db.getRepository<MatchOfficialEntity>('MatchOfficial');
    const extraRepo = db.getRepository<MatchExtraEntity>('MatchExtra');
    const metaRepo = db.getRepository<AppMetaEntity>('AppMeta');

    const matchA = scMatch(idA);
    await officialRepo.save({
      id: idA,
      clubId: clubA,
      date: matchA.date,
      time: matchA.time,
      sourceMatchId: matchA.sourceMatchId ?? null,
      payload: serializeMatchPayload(matchA),
    });
    await extraRepo.save({
      matchId: idA,
      clubId: clubA,
      payload: serializeMatchExtrasPayload({
        id: idA,
        officialSourceSnapshot: matchA,
      }),
    });
    await officialRepo.save({
      id: idB,
      clubId: clubB,
      date: '02/09/2026',
      time: '11:00',
      sourceMatchId: null,
      payload: serializeMatchPayload(manualMatch(idB)),
    });
    await db.query(
      `INSERT INTO planning_records (id, club_id, kind, payload)
       VALUES (?, ?, 'published-planning', ?)`,
      [publishedId, clubA, JSON.stringify({
        schemaVersion: 1,
        publishedAt: '2026-09-01T00:00:00.000Z',
        publishedByUserId: 1,
        events: [{
          eventId: idA,
          eventType: 'officiel',
          title: 'Equipe A – Equipe B',
          date: matchA.date,
          time: matchA.time,
          durationMinutes: 90,
          location: null,
          planningStatus: 'published',
          event: matchA,
          extras: { id: idA, officialSourceSnapshot: matchA },
          assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
        }],
      })],
    );
    await metaRepo.save({
      key: `matches_club_info:${clubA}`,
      value: JSON.stringify({ name: 'Club A', description: '', logo: 'https://api.sportcorico.com/logos/c.png' }),
    });
    await metaRepo.save({
      key: `matches_url:${clubA}`,
      value: 'https://www.sportcorico.com/clubs/demo',
    });

    try {
      const dry = await auditSportCoricoData(db, { apply: false, clubIds: [clubA, clubB] });
      expect(dry.mode).toBe('dry-run');
      expect(dry.counts.officialMatches.records).toBeGreaterThanOrEqual(1);
      expect(dry.counts.extrasSnapshots).toBeGreaterThanOrEqual(1);
      expect(dry.counts.publishedPlannings.records).toBeGreaterThanOrEqual(1);
      expect(dry.counts.clubMeta).toBeGreaterThanOrEqual(1);
      expect(dry.counts.dirtyOfficialMatches).toBeGreaterThanOrEqual(1);
      expect(dry.written.officialMatches).toBe(0);
      expect(JSON.stringify(dry)).not.toMatch(/Arbitre Test/);
      expect(JSON.stringify(dry)).not.toMatch(/1 rue/);

      const stillDirty = await officialRepo.findOneByOrFail({ id: idA, clubId: clubA });
      expect((stillDirty.payload as unknown as Match).details?.rawText).toContain('sportcorico-api');

      const applied = await auditSportCoricoData(db, { apply: true, clubIds: [clubA, clubB] });
      expect(applied.mode).toBe('apply');
      expect(applied.written.officialMatches).toBeGreaterThanOrEqual(1);

      const cleaned = await officialRepo.findOneByOrFail({ id: idA, clubId: clubA });
      const cleanedMatch = cleaned.payload as unknown as Match;
      expect(cleanedMatch.details?.rawText).toBe('');
      expect(cleanedMatch.url).toBeUndefined();
      expect(cleanedMatch.staff?.referee).toBe('');
      expect(cleanedMatch.importProvenance?.quarantined).toBe(true);
      expect(cleanedMatch.sourceStatus).toBe('active');
      expect(JSON.stringify(cleanedMatch)).not.toMatch(/Arbitre Test/);

      const extras = await extraRepo.findOneByOrFail({ matchId: idA, clubId: clubA });
      expect((extras.payload as { officialSourceSnapshot?: unknown }).officialSourceSnapshot).toBeUndefined();

      const untouched = await officialRepo.findOneByOrFail({ id: idB, clubId: clubB });
      expect((untouched.payload as unknown as Match).importProvenance?.provider).toBe('manual');
      expect((untouched.payload as unknown as Match).localTeam).toBe('Club B');

      const publishedRows = await db.query(
        'SELECT payload FROM planning_records WHERE id = ? AND club_id = ?',
        [publishedId, clubA],
      ) as Array<{ payload: string }>;
      const publishedRow = publishedRows[0];
      if (!publishedRow) throw new Error('published planning row missing');
      const published = typeof publishedRow.payload === 'string'
        ? JSON.parse(publishedRow.payload)
        : publishedRow.payload;
      const publishedEvent = published.events[0];
      expect(publishedEvent).toBeDefined();
      const publishedMatch = publishedEvent.event as Match;
      expect(publishedMatch.details?.rawText).toBe('');
      expect(publishedMatch.url).toBeFalsy();
      expect(publishedEvent.extras?.officialSourceSnapshot).toBeFalsy();
      expect(JSON.stringify(published)).not.toMatch(/Arbitre Test/);

      const replay = await auditSportCoricoData(db, { apply: true, clubIds: [clubA, clubB] });
      expect(replay.written.officialMatches).toBe(0);
      expect(replay.written.publishedPlannings).toBe(0);
    } finally {
      await extraRepo.delete({ matchId: idA, clubId: clubA });
      await officialRepo.delete({ id: idA, clubId: clubA });
      await officialRepo.delete({ id: idB, clubId: clubB });
      await db.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [publishedId, clubA]);
      await metaRepo.delete({ key: `matches_club_info:${clubA}` });
      await metaRepo.delete({ key: `matches_url:${clubA}` });
    }
  });
});
