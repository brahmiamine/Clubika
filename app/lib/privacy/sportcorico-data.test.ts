import { describe, expect, it } from 'vitest';
import type { Match } from '@/types/match';
import type { MatchExtras } from '@/hooks/useMatchExtras';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';
import {
  clubMetaLooksLikeSportCorico,
  containsForbiddenSportCoricoMark,
  inventoryHasSportCoricoSignals,
  inventorySportCoricoMatch,
  isClubAuthoredOfficialMatch,
  isLicensedClubImport,
  isSportCoricoAssetUrl,
  isSportCoricoDataPurgeEnabled,
  isSportCoricoMatchPayload,
  sanitizeClubMeta,
  sanitizeOfficialMatchBundle,
  sanitizePublishedPlanningEvents,
  sanitizeSportCoricoMatch,
  tallyInventories,
} from './sportcorico-data';

function officialFromSc(overrides: Partial<Match> = {}): Match {
  return {
    id: 'm1',
    type: 'officiel',
    date: '01/09/2026',
    time: '15:00',
    durationMinutes: 90,
    competition: 'Championnat',
    categorie: 'Seniors',
    localTeam: 'Equipe A',
    awayTeam: 'Equipe B',
    venue: 'domicile',
    horaireRendezVous: '14:00',
    sourceMatchId: '5710278',
    sourceStatus: 'active',
    url: 'https://www.sportcorico.com/match/demo',
    localTeamLogo: 'https://api.sportcorico.com/logos/a.png',
    details: {
      stadium: 'Stade X',
      dateTime: '01/09/2026 - 15:00',
      competition: 'Championnat',
      address: '1 rue du stade',
      terrainType: 'Synthétique',
      itineraryLink: 'https://www.google.com/maps',
      rawText: '{"source":"sportcorico-api","fetchedAt":"2026-09-01T00:00:00.000Z"}',
    },
    staff: {
      referee: 'Arbitre Test',
      assistant1: '',
      assistant2: '',
      rawText: '[{"role":"Arbitre centre"}]',
    },
    ...overrides,
  };
}

describe('isSportCoricoAssetUrl / containsForbiddenSportCoricoMark', () => {
  it('détecte le domaine et les logos Infomaniak /logos/', () => {
    expect(isSportCoricoAssetUrl('https://www.sportcorico.com/foo')).toBe(true);
    expect(isSportCoricoAssetUrl('https://api.sportcorico.com/logos/a.png')).toBe(true);
    expect(isSportCoricoAssetUrl('https://abc.infomaniak.cloud/bucket/logos/x.png')).toBe(true);
    expect(isSportCoricoAssetUrl('https://example.test/match')).toBe(false);
    expect(containsForbiddenSportCoricoMark('voir sportcorico')).toBe(true);
  });
});

describe('isSportCoricoMatchPayload', () => {
  it('détecte rawText, URL et sourceMatchId historiques', () => {
    expect(isSportCoricoMatchPayload(officialFromSc())).toBe(true);
    expect(isSportCoricoMatchPayload({
      id: 'x',
      type: 'amical',
      date: '01/09/2026',
      time: '10:00',
      competition: 'Amical',
      localTeam: 'A',
      awayTeam: 'B',
      venue: 'domicile',
      horaireRendezVous: '09:00',
    })).toBe(false);
  });

  it('ignore les imports club (manuel / CSV)', () => {
    const manual: Match = {
      ...officialFromSc({ sourceMatchId: undefined, url: undefined, localTeamLogo: undefined }),
      importProvenance: { provider: 'manual', rightsAttested: true },
      details: {
        stadium: 'Stade club',
        dateTime: '01/09/2026 - 15:00',
        competition: 'Championnat',
        address: '',
        terrainType: '',
        itineraryLink: '',
        rawText: '',
      },
      staff: { referee: '', assistant1: '', assistant2: '', rawText: '' },
    };
    expect(isLicensedClubImport(manual)).toBe(true);
    expect(isSportCoricoMatchPayload(manual)).toBe(false);
    expect(isClubAuthoredOfficialMatch(manual)).toBe(true);
    expect(isClubAuthoredOfficialMatch(officialFromSc())).toBe(false);
  });
});

describe('sanitizeOfficialMatchBundle', () => {
  it('conserve le calendrier et retire les traces SportCorico', () => {
    const extras: MatchExtras = {
      id: 'm1',
      officialSourceSnapshot: officialFromSc(),
    };
    const { match, extras: nextExtras, changed } = sanitizeOfficialMatchBundle(officialFromSc(), extras);
    expect(changed).toBe(true);
    expect(match.date).toBe('01/09/2026');
    expect(match.localTeam).toBe('Equipe A');
    expect(match.awayTeam).toBe('Equipe B');
    expect(match.details?.competition).toBe('Championnat');
    expect(match.url).toBeUndefined();
    expect(match.details?.rawText).toBe('');
    expect(match.localTeamLogo).toBeUndefined();
    expect(match.staff?.referee).toBe('');
    expect(match.staff?.rawText).toBe('');
    expect(match.importProvenance?.provider).toBe('sportcorico-api');
    expect(match.importProvenance?.quarantined).toBe(true);
    expect(nextExtras?.officialSourceSnapshot).toBeUndefined();
    expect(JSON.stringify({ match, extras: nextExtras })).not.toMatch(/Arbitre Test/);
    expect(JSON.stringify(match.details)).not.toMatch(/sportcorico/i);
  });

  it('est idempotent et conserve une infrastructure déjà saisie par le club', () => {
    const extras: MatchExtras = {
      id: 'm1',
      officialAdminOverride: { details: { stadium: 'Stade club', address: '2 rue club' } },
    };
    const first = sanitizeOfficialMatchBundle(officialFromSc(), extras);
    expect(first.match.details?.stadium).toBe('Stade X');
    const second = sanitizeOfficialMatchBundle(first.match, first.extras);
    expect(second.changed).toBe(false);
  });
});

describe('sanitizePublishedPlanningEvents', () => {
  it('nettoie les officiels publiés sans toucher aux amicaux', () => {
    const payload = {
      schemaVersion: 1 as const,
      events: [
        {
          eventId: 'm1',
          eventType: 'officiel',
          title: 'source',
          date: '01/09/2026',
          time: '15:00',
          durationMinutes: 90,
          location: null,
          planningStatus: 'published',
          event: officialFromSc(),
          extras: { id: 'm1', officialSourceSnapshot: officialFromSc() },
          assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
        } satisfies PlanningEventSnapshot,
        {
          eventId: 'a1',
          eventType: 'amical',
          title: 'Amical',
          date: '02/09/2026',
          time: '10:00',
          durationMinutes: 90,
          location: null,
          planningStatus: 'published',
          event: {
            id: 'a1',
            type: 'amical',
            date: '02/09/2026',
            time: '10:00',
            competition: 'Amical',
            localTeam: 'A',
            awayTeam: 'B',
            venue: 'domicile',
            horaireRendezVous: '09:00',
          },
          extras: null,
          assignments: { arbitre: [], encadrant: [], accompagnateur: [] },
        } satisfies PlanningEventSnapshot,
      ],
    };
    const { payload: out, changed } = sanitizePublishedPlanningEvents(payload);
    expect(changed).toBe(true);
    expect((out.events[0]?.event as Match).details?.rawText).toBe('');
    expect(out.events[1]?.eventType).toBe('amical');
  });
});

describe('sanitizeClubMeta', () => {
  it('retire le logo et l’URL SportCorico', () => {
    const out = sanitizeClubMeta(
      { name: 'Club', description: '', logo: 'https://api.sportcorico.com/logos/c.png' },
      'https://www.sportcorico.com/clubs/demo',
    );
    expect(out.changed).toBe(true);
    expect(out.club.logo).toBe('');
    expect(out.url).toBe('');
    expect(clubMetaLooksLikeSportCorico({ logo: 'https://api.sportcorico.com/logos/c.png' }, 'https://example.test')).toBe(true);
  });
});

describe('inventory / tally', () => {
  it('compte sans recopier de texte personnel', () => {
    const items = [inventorySportCoricoMatch(officialFromSc())];
    const inventory = items[0]!;
    expect(inventoryHasSportCoricoSignals(inventory)).toBe(true);
    const tally = tallyInventories(items);
    expect(tally.records).toBe(1);
    expect(tally.detailsRawText).toBe(1);
    expect(tally.namedOfficials).toBe(1);
    expect(tally.remoteLogos).toBe(1);
    expect(JSON.stringify({ items, tally })).not.toMatch(/Arbitre Test/);
    expect(JSON.stringify({ items, tally })).not.toMatch(/rawText/);
  });
});

describe('isSportCoricoDataPurgeEnabled', () => {
  it('n’applique la purge que si la variable vaut exactement apply', () => {
    expect(isSportCoricoDataPurgeEnabled({})).toBe(false);
    expect(isSportCoricoDataPurgeEnabled({ SPORTCORICO_DATA_PURGE: '1' })).toBe(false);
    expect(isSportCoricoDataPurgeEnabled({ SPORTCORICO_DATA_PURGE: 'apply' })).toBe(true);
  });
});

describe('sanitizeSportCoricoMatch — déjà propre', () => {
  it('ne modifie pas un match sans signal SportCorico', () => {
    const match: Match = {
      id: 'clean',
      type: 'officiel',
      date: '03/09/2026',
      time: '11:00',
      competition: 'Championnat',
      localTeam: 'A',
      awayTeam: 'B',
      venue: 'domicile',
      horaireRendezVous: '10:00',
      importProvenance: { provider: 'csv', rightsAttested: true },
    };
    expect(sanitizeSportCoricoMatch(match)).toBe(match);
  });
});
