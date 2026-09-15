import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SportCoricoMatchApi } from './sportcorico-api.types';
import {
  assertClubSlugMatchesKey,
  assertMatchBelongsToClub,
  extractSportCoricoMatchSlug,
  fetchAndMapSportCoricoMatchesSettled,
  loadSportCoricoClubPlanning,
  mapSportCoricoClubInfo,
  mapSportCoricoMatch,
  normalizeTime,
} from './sportcorico-api.mapper';

const FETCHED_AT = '2026-09-12T11:00:00.000Z';
const CLUB_NAME = 'Academie Football Paris 18';
const PREVIOUS_SYNC = process.env.SPORTCORICO_SYNC_ENABLED;

beforeAll(() => {
  process.env.SPORTCORICO_SYNC_ENABLED = 'true';
});

afterAll(() => {
  if (PREVIOUS_SYNC === undefined) delete process.env.SPORTCORICO_SYNC_ENABLED;
  else process.env.SPORTCORICO_SYNC_ENABLED = PREVIOUS_SYNC;
});

function apiMatch(overrides: Partial<SportCoricoMatchApi> = {}): SportCoricoMatchApi {
  return {
    id: 5710278,
    slug: 'afp-18-seniors-1-ca-de-paris-14-seniors-1-eeelb',
    home_team: 465083,
    home_team_slug: 'af-paris-18',
    home_team_name: 'Afp 18 Seniors 1',
    home_team_club_slug: 'academie-football-paris-18',
    home_club_name: 'Academie Football Paris 18',
    home_logo: 'https://example.test/logos/logo-afp-18.png',
    outside_team: 464486,
    outside_team_slug: 'paris-ca',
    outside_team_name: 'CA de Paris 14 Seniors 1',
    outside_team_club_slug: 'club-athletique-de-paris-14',
    outside_club_name: 'Club Athletique de Paris 14',
    outside_logo: 'https://example.test/logos/logo-ca-paris-14.png',
    location: 'Stade Poissonniers N° 2 - PARIS',
    planned_date: '13/09/2026',
    planned_time: '13:00',
    day: 'Journée 10',
    championship_name: 'U20 R3',
    pool_name: 'POULE B',
    status: 'À venir',
    officials: [
      {
        id: 1,
        official_scraping_id: 'mn_1',
        first_name: 'KODJOVI',
        last_name: 'D.',
        role: 'Arbitre centre',
        sort_order: 1,
      },
      {
        id: 2,
        first_name: 'SOUFIANE',
        last_name: 'A.',
        role: 'Arbitre Assistant 1',
        sort_order: 2,
      },
      {
        id: 3,
        first_name: 'KARIM',
        last_name: 'B.',
        role: 'Arbitre Central',
        sort_order: 99,
      },
      {
        id: 4,
        first_name: 'ABDERRAHIM',
        last_name: 'K.',
        role: 'Arbitre assistant 2',
        sort_order: 3,
      },
    ],
    infrastructure: {
      id: 4433,
      name: 'Stade Poissonniers N° 2',
      address: null,
      postal_code: null,
      city: 'PARIS',
      latitude: 48.900260747,
      longitude: 2.3481868,
      surface_type: 'Synthétique',
    },
    ...overrides,
  };
}

describe('normalizeTime', () => {
  it('normalise les formats 13:00, 13h00 et 9:05', () => {
    expect(normalizeTime('13:00')).toBe('13:00');
    expect(normalizeTime('13h00')).toBe('13:00');
    expect(normalizeTime('9:05')).toBe('09:05');
  });
});

describe('extractSportCoricoMatchSlug', () => {
  it('extrait le slug depuis une URL ou une valeur déjà normalisée', () => {
    expect(extractSportCoricoMatchSlug('https://www.sportcorico.com/match/afp-18-seniors-1-eeelb'))
      .toBe('afp-18-seniors-1-eeelb');
    expect(extractSportCoricoMatchSlug('afp-18-seniors-1-eeelb')).toBe('afp-18-seniors-1-eeelb');
    expect(extractSportCoricoMatchSlug('')).toBe('');
  });
});

describe('mapSportCoricoMatch', () => {
  it('mappe la réponse API vers le modèle Match interne sans id métier', () => {
    const mapped = mapSportCoricoMatch(apiMatch(), CLUB_NAME, { fetchedAt: FETCHED_AT });

    expect(mapped.id).toBeUndefined();
    expect(mapped).toMatchObject({
      sourceMatchId: '5710278',
      sourceMatchIds: ['5710278'],
      type: 'officiel',
      date: '13/09/2026',
      time: '13:00',
      horaireRendezVous: '11:30',
      localTeam: 'Afp 18 Seniors 1',
      awayTeam: 'CA de Paris 14 Seniors 1',
      venue: 'domicile',
      localTeamLogo: 'https://example.test/logos/logo-afp-18.png',
      awayTeamLogo: 'https://example.test/logos/logo-ca-paris-14.png',
      competition: 'U20 R3 - POULE B - Journée 10',
      categorie: 'U20',
      url: 'https://www.sportcorico.com/match/afp-18-seniors-1-ca-de-paris-14-seniors-1-eeelb',
      sourceStatus: 'active',
      sourceLastSeenAt: FETCHED_AT,
      importProvenance: {
        provider: 'sportcorico-api',
        providerId: '5710278',
        importedAt: FETCHED_AT,
      },
    });
    expect(mapped.details).toMatchObject({
      stadium: 'Stade Poissonniers N° 2 - PARIS',
      dateTime: '13/09/2026 - 13:00',
      competition: 'U20 R3',
      address: 'PARIS',
      terrainType: 'Synthétique',
      itineraryLink: 'https://www.google.com/maps/search/?api=1&query=48.900260747,2.3481868',
    });
    expect(mapped.details?.rawText).toContain('sportcorico-api');
    expect(mapped.details?.rawText).toContain(FETCHED_AT);
    expect(mapped.details?.rawText).not.toContain('latest_home');
  });

  it('marque un match à domicile quand le club configuré est l’équipe home', () => {
    const mapped = mapSportCoricoMatch(apiMatch(), 'AFP 18', { fetchedAt: FETCHED_AT });
    expect(mapped.venue).toBe('domicile');
  });

  it('marque un match à l’extérieur quand le club configuré est l’équipe outside', () => {
    const mapped = mapSportCoricoMatch(apiMatch({
      home_team_name: 'CA de Paris 14 Seniors 1',
      home_club_name: 'Club Athletique de Paris 14',
      home_logo: 'https://example.test/logos/logo-ca-paris-14.png',
      outside_team_name: 'Afp 18 Seniors 1',
      outside_club_name: 'Academie Football Paris 18',
      outside_logo: 'https://example.test/logos/logo-afp-18.png',
    }), CLUB_NAME, { fetchedAt: FETCHED_AT });

    expect(mapped.venue).toBe('extérieur');
    expect(mapped.localTeam).toBe('CA de Paris 14 Seniors 1');
    expect(mapped.awayTeam).toBe('Afp 18 Seniors 1');
  });

  it('mappe les arbitres malgré les variantes de rôle', () => {
    const mapped = mapSportCoricoMatch(apiMatch(), CLUB_NAME, { fetchedAt: FETCHED_AT });

    expect(mapped.staff).toMatchObject({
      referee: 'KODJOVI D.',
      assistant1: 'SOUFIANE A.',
      assistant2: 'ABDERRAHIM K.',
    });
    expect(mapped.staff?.rawText).toContain('Arbitre centre');
  });

  it('extrait U20 depuis championship_name', () => {
    const mapped = mapSportCoricoMatch(apiMatch(), CLUB_NAME, { fetchedAt: FETCHED_AT });
    expect(mapped.categorie).toBe('U20');
  });

  it('rejette un match qui n’appartient pas au club configuré', () => {
    const foreign = apiMatch({
      home_team_name: 'Paris Nord FC U15',
      home_club_name: 'Paris Nord FC',
      outside_team_name: 'Montmartre SC U15',
      outside_club_name: 'Montmartre SC',
    });

    expect(() => assertMatchBelongsToClub(foreign, CLUB_NAME)).toThrow(/n'appartient pas au club/);
    expect(() => mapSportCoricoMatch(foreign, CLUB_NAME)).toThrow(/n'appartient pas au club/);
  });
});

describe('fetchAndMapSportCoricoMatchesSettled', () => {
  it('conserve les matchs valides quand un autre slug échoue en 404', async () => {
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('missing-slug')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({ success: true, match: apiMatch() }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const results = await fetchAndMapSportCoricoMatchesSettled(
      ['afp-18-seniors-1-ca-de-paris-14-seniors-1-eeelb', 'missing-slug'],
      CLUB_NAME,
      fetchImpl,
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.match?.sourceMatchId).toBe('5710278');
    expect(results[0]?.error).toBeUndefined();
    expect(results[1]?.match).toBeUndefined();
    expect(results[1]?.error).toMatch(/SportCorico API 404 pour missing-slug/);
  });
});

describe('mapSportCoricoClubInfo', () => {
  it('mappe le nom, le logo et une description de repli', () => {
    expect(mapSportCoricoClubInfo({
      id: 9655,
      slug: 'chambourcy-asm',
      name: 'Chambourcy ASm.',
      city: 'Chambourcy',
      logo_filename: 'https://example.test/logo-chambourcy.jpg',
    })).toEqual({
      name: 'Chambourcy ASm.',
      description: 'Club de Football à Chambourcy',
      logo: 'https://example.test/logo-chambourcy.jpg',
    });
  });
});

describe('assertClubSlugMatchesKey', () => {
  it('accepte le slug SportCorico configuré', () => {
    expect(() => assertClubSlugMatchesKey({
      id: 9655,
      slug: 'chambourcy-asm',
      name: 'Chambourcy ASm.',
    }, 'chambourcy-asm')).not.toThrow();
  });

  it('refuse un autre club', () => {
    expect(() => assertClubSlugMatchesKey({
      id: 1,
      slug: 'academie-football-paris-18',
      name: 'Academie Football Paris 18',
    }, 'chambourcy-asm')).toThrow(/ne correspond pas à la source/);
  });
});

describe('loadSportCoricoClubPlanning', () => {
  it('charge le club puis enrichit les matchs, même si un détail API échoue', async () => {
    const listed = apiMatch({ infrastructure: undefined });
    const fetchImpl: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes('/clubs/')) {
        return new Response(JSON.stringify({
          success: true,
          club: {
            id: 1,
            slug: 'academie-football-paris-18',
            name: 'Academie Football Paris 18',
            city: 'Paris',
            logo_filename: 'https://example.test/logo-afp.png',
            currentMatches: [{ date: listed.planned_date, matches: [listed] }],
            nextMatches: [{
              date: '20/09/2026',
              matches: [apiMatch({
                id: 99,
                slug: 'missing-detail',
                planned_date: '20/09/2026',
                planned_time: '15:00',
                championship_name: 'SENIORS D2',
                pool_name: 'POULE A',
                day: 'Journée 9',
                location: 'STADE MUNICIPAL 1 - CHAMBOURCY',
                infrastructure: undefined,
                officials: [],
              })],
            }],
          },
        }), { status: 200 });
      }
      if (url.includes('missing-detail')) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        success: true,
        match: apiMatch({
          infrastructure: {
            city: 'PARIS',
            latitude: 48.9,
            longitude: 2.3,
            surface_type: 'Synthétique',
          },
        }),
      }), { status: 200 });
    });

    const result = await loadSportCoricoClubPlanning({
      matchesUrlKey: 'academie-football-paris-18',
      configuredClubName: CLUB_NAME,
      fetchedAt: FETCHED_AT,
      fetchImpl,
    });

    expect(result.club.name).toBe('Academie Football Paris 18');
    expect(result.matches).toHaveLength(2);
    expect(result.matches[0]?.details?.terrainType).toBe('Synthétique');
    expect(result.matches[1]?.sourceMatchId).toBe('99');
    expect(result.matches[1]?.details?.stadium).toBe('STADE MUNICIPAL 1 - CHAMBOURCY');
    expect(result.errors).toEqual([]);
  });
});
