import { compactClubIdentity, teamNameMatchesClub } from './club-identity';
import {
  collectClubWindowMatches,
  fetchSportCoricoClub,
  fetchSportCoricoMatch,
} from './sportcorico-api.client';
import type { SportCoricoClubApi, SportCoricoMatchApi, SportCoricoOfficial } from './sportcorico-api.types';
import { calculateMeetingTime, extractMatchCategorie } from './sportcorico-parser.js';
import type { ClubInfo, Match, MatchDetails, MatchStaff } from '@/types/match';

export const SPORTCORICO_MATCH_PAGE_BASE = 'https://www.sportcorico.com/match';

export interface MapSportCoricoMatchOptions {
  fetchedAt?: string;
}

export function extractSportCoricoMatchSlug(urlOrSlug: string | undefined): string {
  if (!urlOrSlug) return '';
  const trimmed = urlOrSlug.trim();
  if (!trimmed) return '';

  const fromUrl = trimmed.match(/\/match\/([^/?#]+)/i);
  if (fromUrl?.[1]) {
    try {
      return decodeURIComponent(fromUrl[1]);
    } catch {
      return fromUrl[1];
    }
  }

  if (!trimmed.includes('://') && !trimmed.includes('/')) {
    return trimmed;
  }

  return '';
}

export function normalizeTime(value?: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})[:hH](\d{2})/);
  const hours = match?.[1];
  const minutes = match?.[2];
  if (!hours || !minutes) return trimmed;
  return `${hours.padStart(2, '0')}:${minutes}`;
}

function normalizeRole(value = ''): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function formatOfficial(official?: SportCoricoOfficial): string {
  if (!official) return '';
  return [official.first_name, official.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function buildCompetition(api: SportCoricoMatchApi): string {
  return [api.championship_name, api.pool_name, api.day]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' - ');
}

function clubNameForSide(api: SportCoricoMatchApi, side: 'home' | 'away'): string {
  if (side === 'home') {
    return api.home_club_name ?? api.home_team_club_name ?? '';
  }
  return api.outside_club_name ?? api.outside_team_club_name ?? '';
}

function sideMatchesClub(api: SportCoricoMatchApi, configuredClubName: string, side: 'home' | 'away'): boolean {
  const teamName = side === 'home' ? api.home_team_name : api.outside_team_name;
  return teamNameMatchesClub(teamName ?? '', configuredClubName)
    || teamNameMatchesClub(clubNameForSide(api, side), configuredClubName);
}

export function assertMatchBelongsToClub(api: SportCoricoMatchApi, configuredClubName: string): void {
  if (sideMatchesClub(api, configuredClubName, 'home') || sideMatchesClub(api, configuredClubName, 'away')) {
    return;
  }

  throw new Error(`Match ${api.slug} n'appartient pas au club ${configuredClubName}`);
}

export function determineVenue(
  api: SportCoricoMatchApi,
  configuredClubName: string,
): 'domicile' | 'extérieur' {
  return sideMatchesClub(api, configuredClubName, 'home') ? 'domicile' : 'extérieur';
}

function extractAddress(api: SportCoricoMatchApi): string {
  const infra = api.infrastructure;
  if (!infra) return '';
  return [infra.address, infra.postal_code, infra.city]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(' - ');
}

function buildItineraryLink(api: SportCoricoMatchApi): string {
  const infra = api.infrastructure;
  if (typeof infra?.latitude === 'number' && typeof infra.longitude === 'number') {
    return `https://www.google.com/maps/search/?api=1&query=${infra.latitude},${infra.longitude}`;
  }

  const query = extractAddress(api) || api.location?.trim() || '';
  if (!query) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function sourceSnapshot(api: SportCoricoMatchApi) {
  return {
    id: api.id,
    slug: api.slug,
    home_team_name: api.home_team_name,
    outside_team_name: api.outside_team_name,
    home_club_name: clubNameForSide(api, 'home'),
    outside_club_name: clubNameForSide(api, 'away'),
    planned_date: api.planned_date,
    planned_time: api.planned_time,
    location: api.location,
    championship_name: api.championship_name,
    pool_name: api.pool_name,
    day: api.day,
    status: api.status,
    officials: api.officials,
    infrastructure: api.infrastructure,
  };
}

export function mapOfficials(officials: SportCoricoOfficial[] | undefined): MatchStaff {
  const list = officials ?? [];
  const referee = list.find((official) => {
    const role = normalizeRole(official.role);
    return role.includes('arbitre centre') || role.includes('arbitre central');
  });
  const assistant1 = list.find((official) => normalizeRole(official.role).includes('arbitre assistant 1'));
  const assistant2 = list.find((official) => normalizeRole(official.role).includes('arbitre assistant 2'));

  return {
    referee: formatOfficial(referee),
    assistant1: formatOfficial(assistant1),
    assistant2: formatOfficial(assistant2),
    rawText: JSON.stringify(list),
  };
}

function mapDetails(api: SportCoricoMatchApi, fetchedAt: string): MatchDetails {
  return {
    stadium: api.location ?? '',
    dateTime: [api.planned_date, api.planned_time].filter(Boolean).join(' - '),
    competition: api.championship_name ?? '',
    address: extractAddress(api),
    terrainType: api.infrastructure?.surface_type ?? '',
    itineraryLink: buildItineraryLink(api),
    rawText: JSON.stringify({
      source: 'sportcorico-api',
      fetchedAt,
      data: sourceSnapshot(api),
    }),
  };
}

export function mapSportCoricoMatch(
  api: SportCoricoMatchApi,
  configuredClubName: string,
  options: MapSportCoricoMatchOptions = {},
): Match {
  assertMatchBelongsToClub(api, configuredClubName);

  const time = normalizeTime(api.planned_time);
  const sourceMatchId = String(api.id);
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  const competition = buildCompetition(api);

  return {
    type: 'officiel',
    sourceMatchId,
    sourceMatchIds: [sourceMatchId],
    date: api.planned_date ?? '',
    time,
    horaireRendezVous: calculateMeetingTime(time),
    localTeam: api.home_team_name,
    awayTeam: api.outside_team_name,
    venue: determineVenue(api, configuredClubName),
    localTeamLogo: api.home_team_logo ?? api.home_logo ?? '',
    awayTeamLogo: api.outside_team_logo ?? api.outside_logo ?? '',
    competition,
    categorie: extractMatchCategorie({
      competition: api.championship_name ?? api.category_name ?? '',
      localTeam: api.home_team_name,
      awayTeam: api.outside_team_name,
      matchId: api.slug,
    }),
    url: `${SPORTCORICO_MATCH_PAGE_BASE}/${api.slug}`,
    details: mapDetails(api, fetchedAt),
    staff: mapOfficials(api.officials),
    sourceStatus: 'active',
    sourceLastSeenAt: fetchedAt,
    importProvenance: {
      provider: 'sportcorico-api',
      providerId: sourceMatchId,
      importedAt: fetchedAt,
    },
  };
}

export async function fetchAndMapSportCoricoMatch(
  slug: string,
  configuredClubName: string,
  fetchImpl?: typeof fetch,
): Promise<Match> {
  const apiMatch = await fetchSportCoricoMatch(slug, fetchImpl);
  return mapSportCoricoMatch(apiMatch, configuredClubName);
}

export async function fetchAndMapSportCoricoMatchesSettled(
  slugs: string[],
  configuredClubName: string,
  fetchImpl?: typeof fetch,
): Promise<Array<{ slug: string; match?: Match; error?: string }>> {
  const results = await Promise.allSettled(
    slugs.map(async (slug) => ({
      slug,
      match: await fetchAndMapSportCoricoMatch(slug, configuredClubName, fetchImpl),
    })),
  );

  return results.map((result, index) => {
    const slug = slugs[index] ?? '';
    if (result.status === 'fulfilled') return result.value;
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { slug, error: message };
  });
}

export function mapSportCoricoClubInfo(club: SportCoricoClubApi): ClubInfo {
  const city = club.city?.trim() ?? '';
  return {
    name: club.name.trim(),
    description: club.description?.trim() || (city ? `Club de Football à ${city}` : ''),
    logo: club.logo_filename ?? club.logo ?? '',
  };
}

export function assertClubSlugMatchesKey(club: SportCoricoClubApi, matchesUrlKey: string): void {
  const actual = club.slug.trim().toLowerCase();
  const expected = matchesUrlKey.trim().toLowerCase();
  if (actual && expected && actual === expected) return;
  if (actual && expected && compactClubIdentity(actual) === compactClubIdentity(expected)) return;
  throw new Error(`Le club SportCorico ${club.slug} ne correspond pas à la source ${matchesUrlKey}`);
}

function mergeMatchPayload(listed: SportCoricoMatchApi, detailed?: SportCoricoMatchApi): SportCoricoMatchApi {
  if (!detailed) return listed;
  return {
    ...listed,
    ...detailed,
    officials: detailed.officials?.length ? detailed.officials : listed.officials,
    infrastructure: detailed.infrastructure ?? listed.infrastructure,
  };
}

export async function enrichListedMatchFromApi(
  listed: SportCoricoMatchApi,
  configuredClubName: string,
  options: MapSportCoricoMatchOptions & { fetchImpl?: typeof fetch } = {},
): Promise<Match> {
  try {
    const detailed = await fetchSportCoricoMatch(listed.slug, options.fetchImpl);
    return mapSportCoricoMatch(mergeMatchPayload(listed, detailed), configuredClubName, options);
  } catch {
    return mapSportCoricoMatch(listed, configuredClubName, options);
  }
}

export async function loadSportCoricoClubPlanning(options: {
  matchesUrlKey: string;
  configuredClubName: string;
  fetchedAt?: string;
  fetchImpl?: typeof fetch;
  concurrency?: number;
}): Promise<{
  club: ClubInfo;
  matches: Match[];
  errors: Array<{ slug: string; message: string }>;
}> {
  const club = await fetchSportCoricoClub(options.matchesUrlKey, options.fetchImpl);
  assertClubSlugMatchesKey(club, options.matchesUrlKey);

  const listedMatches = collectClubWindowMatches(club);
  const concurrency = options.concurrency ?? 15;
  const matches: Match[] = [];
  const errors: Array<{ slug: string; message: string }> = [];

  for (let index = 0; index < listedMatches.length; index += concurrency) {
    const chunk = listedMatches.slice(index, index + concurrency);
    const results = await Promise.allSettled(
      chunk.map((listed) => enrichListedMatchFromApi(listed, options.configuredClubName, options)),
    );

    results.forEach((result, chunkIndex) => {
      const listed = chunk[chunkIndex];
      if (result.status === 'fulfilled') {
        matches.push(result.value);
        return;
      }
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      errors.push({ slug: listed?.slug ?? '', message });
    });
  }

  return {
    club: mapSportCoricoClubInfo(club),
    matches,
    errors,
  };
}
