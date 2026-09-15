import type { DataSource } from 'typeorm';
import type { AppMetaEntity, MatchExtraEntity, MatchOfficialEntity } from '@/lib/db/schemas';
import {
  parseMatchExtrasPayload,
  parseMatchPayload,
  serializeMatchExtrasPayload,
  serializeMatchPayload,
} from '@/lib/db/planning-payload-codecs';
import type { PublishedPlanningHistoryPayload, PublishedPlanningPayload } from '@/lib/planning/published-planning';
import {
  clubMetaLooksLikeSportCorico,
  EMPTY_SPORTCORICO_TALLY,
  extrasHasSportCoricoSnapshot,
  inventorySportCoricoMatch,
  isSportCoricoDataPurgeEnabled,
  sanitizeClubMeta,
  sanitizeOfficialMatchBundle,
  sanitizePublishedPlanningEvents,
  tallyInventories,
  type SportCoricoInventory,
  type SportCoricoTally,
} from '@/lib/privacy/sportcorico-data';
import type { Match } from '@/types/match';

const CLUB_INFO_PREFIX = 'matches_club_info:';
const MATCHES_URL_PREFIX = 'matches_url:';

export interface SportCoricoAuditCounts {
  officialMatches: SportCoricoTally;
  extrasSnapshots: number;
  publishedPlannings: SportCoricoTally;
  publishedHistories: SportCoricoTally;
  clubMeta: number;
  dirtyOfficialMatches: number;
  dirtyPublishedPlannings: number;
  dirtyPublishedHistories: number;
  skippedInvalid: number;
  clubCount: number;
}

export interface SportCoricoAuditReport {
  mode: 'dry-run' | 'apply';
  counts: SportCoricoAuditCounts;
  written: {
    officialMatches: number;
    extras: number;
    publishedPlannings: number;
    publishedHistories: number;
    clubMeta: number;
  };
}

function emptyCounts(): SportCoricoAuditCounts {
  return {
    officialMatches: { ...EMPTY_SPORTCORICO_TALLY },
    extrasSnapshots: 0,
    publishedPlannings: { ...EMPTY_SPORTCORICO_TALLY },
    publishedHistories: { ...EMPTY_SPORTCORICO_TALLY },
    clubMeta: 0,
    dirtyOfficialMatches: 0,
    dirtyPublishedPlannings: 0,
    dirtyPublishedHistories: 0,
    skippedInvalid: 0,
    clubCount: 0,
  };
}

function parsePlanningPayload<T>(raw: unknown): T | null {
  if (raw && typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function tallySnapshots(events: Array<{ event?: unknown; extras?: unknown }> | undefined): SportCoricoTally {
  const inventories = (events ?? []).map((snapshot) => inventorySportCoricoMatch(snapshot.event as Match | undefined));
  return tallyInventories(inventories);
}

export async function auditSportCoricoData(
  db: DataSource,
  options: { apply?: boolean; clubIds?: string[] } = {},
): Promise<SportCoricoAuditReport> {
  const apply = options.apply === true;
  const clubFilter = options.clubIds && options.clubIds.length > 0
    ? new Set(options.clubIds)
    : null;
  const counts = emptyCounts();
  const written = {
    officialMatches: 0,
    extras: 0,
    publishedPlannings: 0,
    publishedHistories: 0,
    clubMeta: 0,
  };
  const clubs = new Set<string>();

  const officialRepo = db.getRepository<MatchOfficialEntity>('MatchOfficial');
  const extraRepo = db.getRepository<MatchExtraEntity>('MatchExtra');
  const metaRepo = db.getRepository<AppMetaEntity>('AppMeta');

  const [officialRows, extraRows] = await Promise.all([
    officialRepo.find(),
    extraRepo.find(),
  ]);
  const scopedOfficials = clubFilter
    ? officialRows.filter((row) => clubFilter.has(row.clubId))
    : officialRows;
  const scopedExtras = clubFilter
    ? extraRows.filter((row) => clubFilter.has(row.clubId))
    : extraRows;
  const extrasByClubMatch = new Map<string, MatchExtraEntity>();
  for (const extra of scopedExtras) {
    extrasByClubMatch.set(`${extra.clubId}:${extra.matchId}`, extra);
  }

  const officialInventories: SportCoricoInventory[] = [];
  for (const row of scopedOfficials) {
    clubs.add(row.clubId);
    let match: Match;
    try {
      match = parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' });
    } catch {
      counts.skippedInvalid += 1;
      continue;
    }
    const extraRow = extrasByClubMatch.get(`${row.clubId}:${row.id}`);
    let extras = null;
    try {
      extras = extraRow ? parseMatchExtrasPayload(extraRow.payload, row.id) : null;
    } catch {
      counts.skippedInvalid += 1;
    }
    officialInventories.push(inventorySportCoricoMatch(match));
    if (extrasHasSportCoricoSnapshot(extras)) counts.extrasSnapshots += 1;

    const bundle = sanitizeOfficialMatchBundle(match, extras);
    if (bundle.changed) counts.dirtyOfficialMatches += 1;
    if (!apply || !bundle.changed) continue;

    row.payload = serializeMatchPayload(bundle.match);
    await officialRepo.save(row);
    written.officialMatches += 1;
    if (extraRow) {
      extraRow.payload = serializeMatchExtrasPayload(bundle.extras ?? { id: row.id });
      await extraRepo.save(extraRow);
      written.extras += 1;
    }
  }
  counts.officialMatches = tallyInventories(officialInventories);

  const planningRows = (await db.query(
    `SELECT id, club_id AS clubId, kind, payload
       FROM planning_records
      WHERE kind IN ('published-planning', 'published-planning-history')`,
  ) as Array<{ id: string; clubId: string; kind: string; payload: unknown }>)
    .filter((row) => !clubFilter || clubFilter.has(row.clubId));

  for (const row of planningRows) {
    clubs.add(row.clubId);
    const parsed = parsePlanningPayload<PublishedPlanningPayload | PublishedPlanningHistoryPayload>(row.payload);
    if (!parsed) {
      counts.skippedInvalid += 1;
      continue;
    }
    const tally = tallySnapshots(parsed.events);
    const sanitized = sanitizePublishedPlanningEvents(parsed);
    if (row.kind === 'published-planning') {
      counts.publishedPlannings.records += tally.records;
      counts.publishedPlannings.detailsRawText += tally.detailsRawText;
      counts.publishedPlannings.staffRawText += tally.staffRawText;
      counts.publishedPlannings.namedOfficials += tally.namedOfficials;
      counts.publishedPlannings.remoteLogos += tally.remoteLogos;
      counts.publishedPlannings.sportcoricoUrl += tally.sportcoricoUrl;
      counts.publishedPlannings.infrastructure += tally.infrastructure;
      counts.publishedPlannings.sourceMatchId += tally.sourceMatchId;
      if (sanitized.changed) counts.dirtyPublishedPlannings += 1;
      if (apply && sanitized.changed) {
        await db.query(
          'UPDATE planning_records SET payload = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND club_id = ?',
          [JSON.stringify(sanitized.payload), row.id, row.clubId],
        );
        written.publishedPlannings += 1;
      }
    } else {
      counts.publishedHistories.records += tally.records;
      counts.publishedHistories.detailsRawText += tally.detailsRawText;
      counts.publishedHistories.staffRawText += tally.staffRawText;
      counts.publishedHistories.namedOfficials += tally.namedOfficials;
      counts.publishedHistories.remoteLogos += tally.remoteLogos;
      counts.publishedHistories.sportcoricoUrl += tally.sportcoricoUrl;
      counts.publishedHistories.infrastructure += tally.infrastructure;
      counts.publishedHistories.sourceMatchId += tally.sourceMatchId;
      if (sanitized.changed) counts.dirtyPublishedHistories += 1;
      if (apply && sanitized.changed) {
        await db.query(
          'UPDATE planning_records SET payload = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND club_id = ?',
          [JSON.stringify(sanitized.payload), row.id, row.clubId],
        );
        written.publishedHistories += 1;
      }
    }
  }

  const metaRows = await metaRepo.find();
  const clubInfo = new Map<string, AppMetaEntity>();
  const clubUrl = new Map<string, AppMetaEntity>();
  for (const row of metaRows) {
    if (row.key.startsWith(CLUB_INFO_PREFIX)) {
      clubInfo.set(row.key.slice(CLUB_INFO_PREFIX.length), row);
    } else if (row.key.startsWith(MATCHES_URL_PREFIX)) {
      clubUrl.set(row.key.slice(MATCHES_URL_PREFIX.length), row);
    }
  }
  const clubIds = new Set([...clubInfo.keys(), ...clubUrl.keys()]);
  for (const clubId of clubIds) {
    if (clubFilter && !clubFilter.has(clubId)) continue;
    clubs.add(clubId);
    const infoRow = clubInfo.get(clubId);
    const urlRow = clubUrl.get(clubId);
    let club = { name: '', description: '', logo: '' };
    if (infoRow?.value) {
      try {
        club = { ...club, ...(JSON.parse(infoRow.value) as typeof club) };
      } catch {
        counts.skippedInvalid += 1;
        continue;
      }
    }
    const url = urlRow?.value ?? '';
    if (!clubMetaLooksLikeSportCorico(club, url)) continue;
    counts.clubMeta += 1;
    const sanitized = sanitizeClubMeta(club, url);
    if (!apply || !sanitized.changed) continue;
    if (infoRow) {
      infoRow.value = JSON.stringify(sanitized.club);
      await metaRepo.save(infoRow);
    }
    if (urlRow) {
      urlRow.value = sanitized.url;
      await metaRepo.save(urlRow);
    }
    written.clubMeta += 1;
  }

  counts.clubCount = clubs.size;
  const report: SportCoricoAuditReport = {
    mode: apply ? 'apply' : 'dry-run',
    counts,
    written,
  };
  console.warn(`[migrations] 0027 audit_quarantaine_sportcorico (${report.mode}): ${JSON.stringify(report)}`);
  return report;
}

export async function runSportCoricoDataAudit(db: DataSource): Promise<void> {
  await auditSportCoricoData(db, { apply: isSportCoricoDataPurgeEnabled() });
}
