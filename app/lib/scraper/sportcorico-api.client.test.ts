import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectClubWindowMatches,
  fetchSportCoricoClub,
  fetchSportCoricoMatch,
  parseSportCoricoClubApiResponse,
  parseSportCoricoMatchApiResponse,
  sportCoricoClubApiUrl,
  sportCoricoMatchApiUrl,
} from './sportcorico-api.client';

describe('parseSportCoricoMatchApiResponse', () => {
  it('refuse un JSON sans objet match', () => {
    expect(() => parseSportCoricoMatchApiResponse({}, 'demo-slug')).toThrow(
      'Réponse SportCorico invalide pour demo-slug',
    );
    expect(() => parseSportCoricoMatchApiResponse({ match: {} }, 'demo-slug')).toThrow(
      'Réponse SportCorico invalide pour demo-slug',
    );
  });
});

describe('fetchSportCoricoMatch', () => {
  beforeEach(() => {
    vi.stubEnv('SPORTCORICO_SYNC_ENABLED', 'true');
  });
  it('retourne le match API quand la réponse est valide', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      match: {
        id: 5710278,
        slug: 'demo-slug',
        home_team_name: 'Afp 18 Seniors 1',
        outside_team_name: 'CA de Paris 14 Seniors 1',
      },
    }), { status: 200 }));

    await expect(fetchSportCoricoMatch('demo-slug', fetchImpl)).resolves.toMatchObject({
      id: 5710278,
      slug: 'demo-slug',
    });
    expect(fetchImpl).toHaveBeenCalledWith(sportCoricoMatchApiUrl('demo-slug'), {
      headers: { Accept: 'application/json' },
    });
  });

  it('signale une erreur explicite sur un 404', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response('missing', { status: 404 }));
    await expect(fetchSportCoricoMatch('missing-slug', fetchImpl)).rejects.toThrow(
      'SportCorico API 404 pour missing-slug',
    );
  });

  it('signale une erreur explicite quand le JSON est invalide', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response('{', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(fetchSportCoricoMatch('broken-slug', fetchImpl)).rejects.toThrow(
      'Réponse SportCorico invalide pour broken-slug',
    );
  });

  it('bloque l’appel si SPORTCORICO_SYNC_ENABLED n’est pas true', async () => {
    vi.stubEnv('SPORTCORICO_SYNC_ENABLED', '');
    const fetchImpl: typeof fetch = vi.fn(async () => new Response('nope'));
    await expect(fetchSportCoricoMatch('demo-slug', fetchImpl)).rejects.toThrow(/désactivée/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('parseSportCoricoClubApiResponse', () => {
  it('refuse un JSON sans objet club valide', () => {
    expect(() => parseSportCoricoClubApiResponse({}, 'chambourcy-asm')).toThrow(
      'Réponse SportCorico invalide pour le club chambourcy-asm',
    );
    expect(() => parseSportCoricoClubApiResponse({ club: { slug: 'x' } }, 'chambourcy-asm')).toThrow(
      'Réponse SportCorico invalide pour le club chambourcy-asm',
    );
  });
});

describe('collectClubWindowMatches', () => {
  it('fusionne previous/current/next sans doublon', () => {
    const matches = collectClubWindowMatches({
      id: 9655,
      slug: 'chambourcy-asm',
      name: 'Chambourcy ASm.',
      currentMatches: [{
        date: '13/09/2026',
        matches: [{
          id: 1,
          slug: 'current-slug',
          home_team_name: 'Chambourcy Asm Seniors 1',
          outside_team_name: 'Bry FC Seniors 1',
        }],
      }],
      next_games: [{
        date: '20/09/2026',
        matches: [
          {
            id: 1,
            slug: 'current-slug',
            home_team_name: 'Chambourcy Asm Seniors 1',
            outside_team_name: 'Bry FC Seniors 1',
          },
          {
            id: 2,
            slug: 'next-slug',
            home_team_name: 'Chambourcy Asm U14 1',
            outside_team_name: 'Chesnay 78 FC Le U14 1',
          },
        ],
      }],
    });

    expect(matches.map((match) => match.slug)).toEqual(['current-slug', 'next-slug']);
  });
});

describe('fetchSportCoricoClub', () => {
  beforeEach(() => {
    vi.stubEnv('SPORTCORICO_SYNC_ENABLED', 'true');
  });
  it('retourne le club API quand la réponse est valide', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      club: {
        id: 9655,
        slug: 'chambourcy-asm',
        name: 'Chambourcy ASm.',
        currentMatches: [],
      },
    }), { status: 200 }));

    await expect(fetchSportCoricoClub('chambourcy-asm', fetchImpl)).resolves.toMatchObject({
      id: 9655,
      slug: 'chambourcy-asm',
      name: 'Chambourcy ASm.',
    });
    expect(fetchImpl).toHaveBeenCalledWith(sportCoricoClubApiUrl('chambourcy-asm'), {
      headers: { Accept: 'application/json' },
    });
  });

  it('signale une erreur explicite sur un 404 club', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => new Response('missing', { status: 404 }));
    await expect(fetchSportCoricoClub('inconnu', fetchImpl)).rejects.toThrow(
      'SportCorico API 404 pour le club inconnu',
    );
  });
});
