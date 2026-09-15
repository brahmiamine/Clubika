import type {
  SportCoricoClubApi,
  SportCoricoClubApiResponse,
  SportCoricoClubMatchGroup,
  SportCoricoMatchApi,
  SportCoricoMatchApiResponse,
} from './sportcorico-api.types';
import { guardedFetch } from '@/lib/compliance/external-services';
import { assertSportCoricoSyncEnabled } from './sync-gate';

export const SPORTCORICO_API_BASE_URL = 'https://api.sportcorico.com/api';
export const SPORTCORICO_CLUB_PAGE_BASE = 'https://www.sportcorico.com/clubs';

export function sportCoricoMatchApiUrl(slug: string): string {
  return `${SPORTCORICO_API_BASE_URL}/match/${encodeURIComponent(slug)}`;
}

export function sportCoricoClubApiUrl(matchesUrlKey: string): string {
  return `${SPORTCORICO_API_BASE_URL}/clubs/${encodeURIComponent(matchesUrlKey)}`;
}

export function sportCoricoClubPageUrl(matchesUrlKey: string): string {
  return `${SPORTCORICO_CLUB_PAGE_BASE}/${matchesUrlKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function isSportCoricoMatchApi(value: unknown): value is SportCoricoMatchApi {
  if (!isRecord(value)) return false;
  return typeof value.id === 'number' && typeof value.slug === 'string' && value.slug.trim().length > 0;
}

export function parseSportCoricoMatchApiResponse(payload: unknown, slug: string): SportCoricoMatchApi {
  if (!isRecord(payload) || !isSportCoricoMatchApi(payload.match)) {
    throw new Error(`Réponse SportCorico invalide pour ${slug}`);
  }
  return payload.match;
}

export async function fetchSportCoricoMatch(
  slug: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SportCoricoMatchApi> {
  assertSportCoricoSyncEnabled();
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) {
    throw new Error('Slug SportCorico manquant');
  }

  const response = await guardedFetch('sportcorico', sportCoricoMatchApiUrl(trimmedSlug), {
    headers: {
      Accept: 'application/json',
    },
  }, fetchImpl);

  if (!response.ok) {
    throw new Error(`SportCorico API ${response.status} pour ${trimmedSlug}`);
  }

  let payload: unknown;
  try {
    payload = await response.json() as SportCoricoMatchApiResponse;
  } catch {
    throw new Error(`Réponse SportCorico invalide pour ${trimmedSlug}`);
  }

  return parseSportCoricoMatchApiResponse(payload, trimmedSlug);
}

function isSportCoricoClubApi(value: unknown): value is SportCoricoClubApi {
  if (!isRecord(value)) return false;
  return typeof value.id === 'number'
    && typeof value.slug === 'string'
    && value.slug.trim().length > 0
    && typeof value.name === 'string'
    && value.name.trim().length > 0;
}

function matchGroups(value: unknown): SportCoricoClubMatchGroup[] {
  return Array.isArray(value) ? value as SportCoricoClubMatchGroup[] : [];
}

export function parseSportCoricoClubApiResponse(payload: unknown, matchesUrlKey: string): SportCoricoClubApi {
  if (!isRecord(payload) || !isSportCoricoClubApi(payload.club)) {
    throw new Error(`Réponse SportCorico invalide pour le club ${matchesUrlKey}`);
  }
  return payload.club;
}

export function collectClubWindowMatches(club: SportCoricoClubApi): SportCoricoMatchApi[] {
  const groups = [
    ...matchGroups(club.previousMatches ?? club.previous_matches ?? club.previous_games),
    ...matchGroups(club.currentMatches ?? club.current_matches ?? club.current_games),
    ...matchGroups(club.nextMatches ?? club.next_matches ?? club.next_games),
  ];

  const byId = new Map<number, SportCoricoMatchApi>();
  for (const group of groups) {
    for (const match of group.matches ?? []) {
      if (!isSportCoricoMatchApi(match)) continue;
      byId.set(match.id, match);
    }
  }
  return [...byId.values()];
}

export async function fetchSportCoricoClub(
  matchesUrlKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SportCoricoClubApi> {
  assertSportCoricoSyncEnabled();
  const trimmedKey = matchesUrlKey.trim();
  if (!trimmedKey) {
    throw new Error('Clé de club SportCorico manquante');
  }

  const response = await guardedFetch('sportcorico', sportCoricoClubApiUrl(trimmedKey), {
    headers: {
      Accept: 'application/json',
    },
  }, fetchImpl);

  if (!response.ok) {
    throw new Error(`SportCorico API ${response.status} pour le club ${trimmedKey}`);
  }

  let payload: unknown;
  try {
    payload = await response.json() as SportCoricoClubApiResponse;
  } catch {
    throw new Error(`Réponse SportCorico invalide pour le club ${trimmedKey}`);
  }

  return parseSportCoricoClubApiResponse(payload, trimmedKey);
}
