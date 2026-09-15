import type { ImportProvenance, LicensedImportProvider, Match, MatchDetails, MatchStaff } from '@/types/match';
import type { MatchExtras } from '@/hooks/useMatchExtras';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';

export const SPORTCORICO_DATA_PURGE_ENV = 'SPORTCORICO_DATA_PURGE';

export type { ImportProvenance, LicensedImportProvider } from '@/types/match';

const LICENSED_PROVIDERS: ReadonlySet<string> = new Set<LicensedImportProvider>(['manual', 'csv', 'licensed-api']);

export interface SportCoricoInventory {
  match: boolean;
  detailsRawText: boolean;
  staffRawText: boolean;
  namedOfficials: boolean;
  remoteLogos: boolean;
  sportcoricoUrl: boolean;
  infrastructure: boolean;
  sourceMatchId: boolean;
}

export interface SportCoricoTally {
  records: number;
  detailsRawText: number;
  staffRawText: number;
  namedOfficials: number;
  remoteLogos: number;
  sportcoricoUrl: number;
  infrastructure: number;
  sourceMatchId: number;
}

export const EMPTY_SPORTCORICO_TALLY: SportCoricoTally = {
  records: 0,
  detailsRawText: 0,
  staffRawText: 0,
  namedOfficials: 0,
  remoteLogos: 0,
  sportcoricoUrl: 0,
  infrastructure: 0,
  sourceMatchId: 0,
};

export function isSportCoricoDataPurgeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SPORTCORICO_DATA_PURGE_ENV] === 'apply';
}

export function isLicensedClubImport(match: Partial<Match> | null | undefined): boolean {
  const provider = match?.importProvenance?.provider;
  if (provider && LICENSED_PROVIDERS.has(provider)) return true;
  const sourceId = match?.sourceMatchId ?? '';
  return /^(csv|manual|licensed):/i.test(sourceId);
}

export function isClubAuthoredOfficialMatch(match: Partial<Match> | null | undefined): boolean {
  if (!match) return false;
  if (isLicensedClubImport(match)) return true;
  return !isSportCoricoMatchPayload(match) && !match.sourceMatchId;
}

export function isSportCoricoAssetUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const lower = value.toLowerCase();
  return lower.includes('sportcorico.com')
    || /infomaniak\.cloud\/[^\s]*\/logos\//i.test(lower)
    || /\/storage\/logos\//i.test(lower);
}

export function containsForbiddenSportCoricoMark(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  const lower = value.toLowerCase();
  return lower.includes('sportcorico') || isSportCoricoAssetUrl(value);
}

export function detailsRawTextIsSportCorico(rawText: unknown): boolean {
  if (typeof rawText !== 'string' || !rawText.trim()) return false;
  return rawText.includes('sportcorico-api') || rawText.includes('sportcorico.com');
}

export function isSportCoricoMatchPayload(match: Partial<Match> | null | undefined): boolean {
  if (!match) return false;
  if (isLicensedClubImport(match)) return false;
  if (match.importProvenance?.provider === 'sportcorico-api' || match.importProvenance?.provider === 'unknown-external') {
    return true;
  }
  if (detailsRawTextIsSportCorico(match.details?.rawText) || detailsRawTextIsSportCorico(match.rawText)) {
    return true;
  }
  if (
    isSportCoricoAssetUrl(match.url)
    || isSportCoricoAssetUrl(match.localTeamLogo)
    || isSportCoricoAssetUrl(match.awayTeamLogo)
  ) {
    return true;
  }
  return Boolean(match.sourceMatchId);
}

function hasNamedOfficials(staff: MatchStaff | null | undefined): boolean {
  if (!staff) return false;
  return Boolean(staff.referee?.trim() || staff.assistant1?.trim() || staff.assistant2?.trim());
}

function hasInfrastructure(details: MatchDetails | null | undefined): boolean {
  if (!details) return false;
  return Boolean(
    details.stadium?.trim()
    || details.address?.trim()
    || details.terrainType?.trim()
    || details.itineraryLink?.trim(),
  );
}

export function inventorySportCoricoMatch(match: Partial<Match> | null | undefined): SportCoricoInventory {
  if (!match) {
    return {
      match: false,
      detailsRawText: false,
      staffRawText: false,
      namedOfficials: false,
      remoteLogos: false,
      sportcoricoUrl: false,
      infrastructure: false,
      sourceMatchId: false,
    };
  }
  const detected = isSportCoricoMatchPayload(match);
  return {
    match: detected,
    detailsRawText: detailsRawTextIsSportCorico(match.details?.rawText) || detailsRawTextIsSportCorico(match.rawText),
    staffRawText: detected && Boolean(match.staff?.rawText?.trim()),
    namedOfficials: detected && hasNamedOfficials(match.staff),
    remoteLogos: isSportCoricoAssetUrl(match.localTeamLogo) || isSportCoricoAssetUrl(match.awayTeamLogo),
    sportcoricoUrl: isSportCoricoAssetUrl(match.url),
    infrastructure: detected && hasInfrastructure(match.details),
    sourceMatchId: detected && Boolean(match.sourceMatchId),
  };
}

export function inventoryHasSportCoricoSignals(inventory: SportCoricoInventory): boolean {
  return inventory.match
    || inventory.detailsRawText
    || inventory.sportcoricoUrl
    || inventory.remoteLogos
    || inventory.sourceMatchId;
}

function emptyStaff(): MatchStaff {
  return { referee: '', assistant1: '', assistant2: '', rawText: '' };
}

function stripDetails(details: MatchDetails | null | undefined, keepOperational: boolean): MatchDetails | null {
  if (!details) return null;
  return {
    stadium: keepOperational ? (details.stadium ?? '') : '',
    dateTime: details.dateTime ?? '',
    competition: details.competition ?? '',
    address: keepOperational ? (details.address ?? '') : '',
    terrainType: keepOperational ? (details.terrainType ?? '') : '',
    itineraryLink: '',
    rawText: '',
  };
}

function quarantinedProvenance(match: Match): ImportProvenance {
  return {
    provider: 'sportcorico-api',
    providerId: match.sourceMatchId,
    importedAt: match.sourceLastSeenAt ?? match.importProvenance?.importedAt,
    quarantined: true,
  };
}

/**
 * Quarantaine : conserve le calendrier opérationnel (date, équipes, compétition)
 * et retire les champs SportCorico non justifiés (rawText, officiels, logos, URL).
 * Ne classifie pas le contenu des textes : ils sont vidés.
 */
export function sanitizeSportCoricoMatch(
  match: Match,
  options: { keepAdminInfrastructure?: boolean } = {},
): Match {
  if (!isSportCoricoMatchPayload(match)) return match;

  const keepInfra = options.keepAdminInfrastructure === true;
  const next: Match = {
    ...match,
    url: undefined,
    rawText: undefined,
    localTeamLogo: isSportCoricoAssetUrl(match.localTeamLogo) ? undefined : match.localTeamLogo,
    awayTeamLogo: isSportCoricoAssetUrl(match.awayTeamLogo) ? undefined : match.awayTeamLogo,
    staff: emptyStaff(),
    details: stripDetails(match.details, keepInfra),
    importProvenance: quarantinedProvenance(match),
  };
  return next;
}

export function extrasHasSportCoricoSnapshot(extras: MatchExtras | null | undefined): boolean {
  if (!extras?.officialSourceSnapshot) return false;
  return isSportCoricoMatchPayload(extras.officialSourceSnapshot);
}

export function sanitizeSportCoricoExtras(extras: MatchExtras | null | undefined): MatchExtras | null | undefined {
  if (!extras) return extras;
  if (!extras.officialSourceSnapshot) return extras;
  const { officialSourceSnapshot: _dropped, ...rest } = extras;
  void _dropped;
  return rest;
}

export function sanitizeOfficialMatchBundle(match: Match, extras: MatchExtras | null | undefined): {
  match: Match;
  extras: MatchExtras | null | undefined;
  changed: boolean;
} {
  const keepAdminInfrastructure = Boolean(
    extras?.officialAdminOverride?.details?.stadium
    || extras?.officialAdminOverride?.details?.address,
  );
  const nextMatch = sanitizeSportCoricoMatch(match, { keepAdminInfrastructure });
  const nextExtras = extrasHasSportCoricoSnapshot(extras) || isSportCoricoMatchPayload(match)
    ? sanitizeSportCoricoExtras(extras)
    : extras;
  const changed = JSON.stringify(match) !== JSON.stringify(nextMatch)
    || JSON.stringify(extras ?? null) !== JSON.stringify(nextExtras ?? null);
  return { match: nextMatch, extras: nextExtras, changed };
}

export function sanitizePlanningSnapshot(snapshot: PlanningEventSnapshot): {
  next: PlanningEventSnapshot;
  changed: boolean;
} {
  if (snapshot.eventType !== 'officiel') {
    return { next: snapshot, changed: false };
  }
  const event = snapshot.event as Match;
  const extras = snapshot.extras as MatchExtras | null;
  const sanitized = sanitizeOfficialMatchBundle(event, extras);
  if (!sanitized.changed) return { next: snapshot, changed: false };
  return {
    changed: true,
    next: {
      ...snapshot,
      event: sanitized.match,
      extras: sanitized.extras ?? null,
      title: `${sanitized.match.localTeam} – ${sanitized.match.awayTeam}`,
    },
  };
}

export function sanitizePublishedPlanningEvents<T extends { events?: PlanningEventSnapshot[] }>(
  payload: T,
): { payload: T; changed: boolean } {
  const events = payload.events;
  if (!Array.isArray(events)) return { payload, changed: false };
  let changed = false;
  const nextEvents = events.map((snapshot) => {
    const result = sanitizePlanningSnapshot(snapshot);
    if (result.changed) changed = true;
    return result.next;
  });
  if (!changed) return { payload, changed: false };
  return { payload: { ...payload, events: nextEvents }, changed: true };
}

export function tallyInventories(items: SportCoricoInventory[]): SportCoricoTally {
  const tally: SportCoricoTally = { ...EMPTY_SPORTCORICO_TALLY };
  for (const item of items) {
    if (!inventoryHasSportCoricoSignals(item)) continue;
    tally.records += 1;
    if (item.detailsRawText) tally.detailsRawText += 1;
    if (item.staffRawText) tally.staffRawText += 1;
    if (item.namedOfficials) tally.namedOfficials += 1;
    if (item.remoteLogos) tally.remoteLogos += 1;
    if (item.sportcoricoUrl) tally.sportcoricoUrl += 1;
    if (item.infrastructure) tally.infrastructure += 1;
    if (item.sourceMatchId) tally.sourceMatchId += 1;
  }
  return tally;
}

export function clubMetaLooksLikeSportCorico(club: { logo?: string } | null | undefined, url?: string): boolean {
  return isSportCoricoAssetUrl(club?.logo) || isSportCoricoAssetUrl(url);
}

export function sanitizeClubMeta(
  club: { name: string; description: string; logo: string },
  url: string,
): { club: { name: string; description: string; logo: string }; url: string; changed: boolean } {
  const nextClub = {
    ...club,
    logo: isSportCoricoAssetUrl(club.logo) ? '' : club.logo,
  };
  const nextUrl = isSportCoricoAssetUrl(url) ? '' : url;
  return {
    club: nextClub,
    url: nextUrl,
    changed: nextClub.logo !== club.logo || nextUrl !== url,
  };
}
