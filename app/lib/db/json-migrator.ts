import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import {
  AppMetaEntity,
  CategorieEntity,
  ClubEntity,
  EntrainementEntity,
  MatchAmicalEntity,
  MatchExtraEntity,
  MatchOfficialEntity,
  PlateauEntity,
  StadeEntity,
  UserEntity,
} from './schemas';
import {
  Entrainement,
  Match,
  OfficialMatchAdminOverride,
  MatchesAmicauxData,
  MatchesData,
  Plateau,
} from '@/types/match';
import { normalizeMatchesData } from './helpers';
import { normalizeIndisponibilites } from '@/lib/utils/officiel-availability';
import { hashPassword } from '@/lib/auth/password';
import { generatePlaceholderEmail } from '@/lib/auth/placeholder-account';
import {
  applyOfficialMatchAdminOverride,
  computeOfficialMatchAdminOverride,
  hasOfficialMatchAdminOverride,
} from '@/lib/planning/official-match-overrides';
import {
  parseMatchExtrasPayload,
  parseMatchPayload,
  serializeMatchExtrasPayload,
  serializeMatchPayload,
} from './planning-payload-codecs';
import { listActiveClubIds } from './club-tenants';

const MIGRATION_KEY = 'json_migrated_v1';
const PLANNING_STATUS_MIGRATION_KEY = 'planning_status_migrated_v1';
const CLUB_INFO_KEY = 'matches_club_info';
const MATCHES_URL_KEY = 'matches_url';
const MATCHES_SCRAPED_AT_KEY = 'matches_scraped_at';
const OFFICIAL_MATCH_SYNC_LOCK = 'clubika_official_match_sync_v1';
const JSON_MIGRATION_LOCK = 'clubika_json_migration_v1';
const MISSING_CONFIRMATIONS_REQUIRED = 2;
const MIN_ACTIVE_MATCHES_FOR_COMPLETENESS_GUARD = 4;
const MAX_MISSING_ACTIVE_RATIO = 0.5;

export interface MatchSyncNotification {
  extras: Record<string, unknown>;
  match: Match;
  type: 'cancelled' | 'updated';
}

export interface OfficialMatchSyncResult {
  activeCount: number;
  createdCount: number;
  missingCount: number;
  notifications: MatchSyncNotification[];
  pendingMissingCount: number;
  updatedCount: number;
}

export function isSuspiciousOfficialSnapshot(
  activeExistingIds: Iterable<string>,
  incomingIds: { has(id: string): boolean; size: number },
): boolean {
  const activeIds = [...activeExistingIds];
  if (activeIds.length < MIN_ACTIVE_MATCHES_FOR_COMPLETENESS_GUARD) return false;
  const missingCount = activeIds.filter((id) => !incomingIds.has(id)).length;
  return missingCount / activeIds.length >= MAX_MISSING_ACTIVE_RATIO
    && incomingIds.size <= activeIds.length * (1 - MAX_MISSING_ACTIVE_RATIO);
}

export function nextSourceMissingObservation(previous: Match): {
  confirmed: boolean;
  count: number;
} {
  const previousCount = previous.sourceStatus === 'missing'
    ? Math.max(previous.sourceMissingObservations ?? MISSING_CONFIRMATIONS_REQUIRED, MISSING_CONFIRMATIONS_REQUIRED)
    : previous.sourceMissingObservations ?? 0;
  const count = previousCount + 1;
  return { confirmed: count >= MISSING_CONFIRMATIONS_REQUIRED, count };
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

const VALID_PLANNING_STATUSES = new Set(['draft', 'published', 'modified', 'cancelled']);

/**
 * Les anciennes données sans statut explicite ne doivent jamais hériter implicitement
 * du comportement `undefined => published`. Elles entrent dans le nouveau workflow
 * comme brouillons jusqu'à la première publication globale.
 */
export function normalizeLegacyPlanningPayload<T extends Record<string, unknown>>(
  payload: T,
): T & { planningStatus: 'draft' | 'published' | 'modified' | 'cancelled' } {
  const status = typeof payload.planningStatus === 'string' && VALID_PLANNING_STATUSES.has(payload.planningStatus)
    ? payload.planningStatus as 'draft' | 'published' | 'modified' | 'cancelled'
    : 'draft';
  return { ...payload, planningStatus: status };
}

function clubMetaKey(key: string, clubId: string): string {
  return `${key}:${clubId}`;
}

function readJsonFile<T>(relativePath: string, fallback: T): T {
  try {
    const absolutePath = path.join(process.cwd(), relativePath);
    if (!fs.existsSync(absolutePath)) {
      return fallback;
    }
    const content = fs.readFileSync(absolutePath, 'utf8');
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}

function flattenByDate<T>(input: Record<string, T[]>): T[] {
  return Object.values(input || {}).flat();
}

export async function ensureDbSchemaForAvailability(dataSource: DataSource): Promise<void> {
  const ensureTableColumn = async (tableName: 'officiels' | 'encadrants' | 'accompagnateurs') => {
    const tableExists = await dataSource.query(
      `SELECT 1 AS ok
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
       LIMIT 1`,
      [tableName],
    ) as Array<{ ok?: number }>;

    if (!Array.isArray(tableExists) || tableExists.length === 0) {
      return;
    }

    const columnInfo = await dataSource.query(
      `SELECT DATA_TYPE AS dataType
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND COLUMN_NAME = 'indisponibilites'
       LIMIT 1`,
      [tableName],
    ) as Array<{ dataType?: string }>;

    if (!Array.isArray(columnInfo) || columnInfo.length === 0) {
      await dataSource.query(
        `ALTER TABLE ${tableName}
         ADD COLUMN indisponibilites LONGTEXT NULL AFTER telephone`,
      );
      return;
    }

    const dataType = String(columnInfo[0]?.dataType ?? '').toLowerCase();
    const validTypes = new Set(['longtext', 'mediumtext', 'text']);

    if (!validTypes.has(dataType)) {
      await dataSource.query(
        `ALTER TABLE ${tableName}
         MODIFY COLUMN indisponibilites LONGTEXT NULL`,
      );
    }
  };

  await ensureTableColumn('officiels');
  await ensureTableColumn('encadrants');
  await ensureTableColumn('accompagnateurs');
}

export async function syncOfficialMatchesData(
  dataSource: DataSource,
  input: MatchesData,
  clubId: string,
): Promise<OfficialMatchSyncResult> {
  const normalized = normalizeMatchesData(input);
  const observedAt = normalized.scrapedAt || new Date().toISOString();
  const incomingById = new Map<string, Match>();
  for (const match of Object.values(normalized.matches).flat()) {
    if (match.id) incomingById.set(match.id, match);
  }

  const runner = dataSource.createQueryRunner();
  await runner.connect();
  let lockAcquired = false;
  try {
    const lockRows = await runner.query(
      'SELECT GET_LOCK(?, 15) AS acquired',
      [`${OFFICIAL_MATCH_SYNC_LOCK}:${clubId}`],
    ) as Array<{ acquired?: number | string }>;
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) throw new Error('Synchronisation des matchs déjà en cours');

    await runner.startTransaction();
    try {
      const result = await syncOfficialMatchesWithManager(
        runner.manager,
        normalized,
        incomingById,
        observedAt,
        clubId,
      );
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    }
  } finally {
    if (lockAcquired) await runner.query('SELECT RELEASE_LOCK(?)', [`${OFFICIAL_MATCH_SYNC_LOCK}:${clubId}`]);
    await runner.release();
  }
}

function scheduleChanged(before: Match, after: Match): boolean {
  return before.date !== after.date
    || before.time !== after.time
    || before.horaireRendezVous !== after.horaireRendezVous
    || before.details?.stadium !== after.details?.stadium
    || before.details?.address !== after.details?.address;
}

function isVisiblePlanningStatus(value: unknown): boolean {
  return value === 'published' || value === 'modified';
}

async function syncOfficialMatchesWithManager(
  manager: EntityManager,
  normalized: MatchesData,
  incomingById: Map<string, Match>,
  observedAt: string,
  clubId: string,
): Promise<OfficialMatchSyncResult> {
  const officialRepo = manager.getRepository<MatchOfficialEntity>('MatchOfficial');
  const extraRepo = manager.getRepository<MatchExtraEntity>('MatchExtra');
  const metaRepo = manager.getRepository<AppMetaEntity>('AppMeta');
  const existingRows = await officialRepo
    .createQueryBuilder('match')
    .setLock('pessimistic_write')
    .where('match.clubId = :clubId', { clubId })
    .getMany();

  const activeExistingRows = existingRows.filter((row) => {
    const payload = parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' });
    return payload.sourceStatus !== 'missing';
  });

  if (incomingById.size === 0 && activeExistingRows.length > 0) {
    throw new Error('Le scraper n’a retourné aucun match ; la synchronisation a été annulée');
  }

  const missingActiveCount = activeExistingRows.filter((row) => !incomingById.has(row.id)).length;
  if (isSuspiciousOfficialSnapshot(activeExistingRows.map((row) => row.id), incomingById)) {
    throw new Error(
      `Snapshot du scraper probablement incomplet (${missingActiveCount}/${activeExistingRows.length} matchs actifs absents) ; synchronisation annulée`,
    );
  }

  const existingById = new Map(existingRows.map((row) => [
    row.id,
    parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' }),
  ]));
  const extraRows = await extraRepo
    .createQueryBuilder('extra')
    .setLock('pessimistic_write')
    .where('extra.clubId = :clubId', { clubId })
    .getMany();
  const extrasById = new Map(extraRows.map((row) => [
    row.matchId,
    parseMatchExtrasPayload(row.payload, row.matchId),
  ]));
  const officialUpserts: Array<Pick<MatchOfficialEntity, 'id' | 'clubId' | 'date' | 'time' | 'sourceMatchId' | 'payload'>> = [];
  const extraUpserts: Array<Pick<MatchExtraEntity, 'matchId' | 'clubId' | 'payload'>> = [];
  const notifications: MatchSyncNotification[] = [];
  let createdCount = 0;
  let updatedCount = 0;

  for (const [matchId, incoming] of incomingById) {
    const previous = existingById.get(matchId);
    const wasMissing = previous?.sourceStatus === 'missing';
    const currentExtras = extrasById.get(matchId) ?? { id: matchId };
    const previousSource = currentExtras.officialSourceSnapshot
      ? parseMatchPayload(
          currentExtras.officialSourceSnapshot,
          'MatchOfficial',
          { id: matchId, type: 'officiel' },
        )
      : undefined;
    const storedOverride = currentExtras.officialAdminOverride as OfficialMatchAdminOverride | null | undefined;

    // Si le match a déjà un snapshot source, la différence entre ce snapshot et la
    // version effective en base correspond aux corrections administrateur. Cette
    // détection couvre aussi les corrections historiques effectuées avant l'ajout
    // explicite des métadonnées d'override.
    const previousEffectiveOverride = previous && previousSource
      ? computeOfficialMatchAdminOverride(previousSource, previous)
      : storedOverride;

    const sourceMatch: Match = {
      ...incoming,
      id: matchId,
      sourceStatus: 'active',
      sourceLastSeenAt: observedAt,
      sourceMissingSince: undefined,
      sourceMissingObservations: 0,
    };
    const activeMatch: Match = {
      ...applyOfficialMatchAdminOverride(sourceMatch, previousEffectiveOverride),
      // La révision appartient à la version effective, pas à la source. Un scrape
      // ne doit pas la remettre à zéro, sinon l'édition optimiste suivante serait
      // rejetée à tort après une synchronisation.
      planningRevision: previous?.planningRevision,
    };
    // On recalcule par rapport à la nouvelle source : si la source a finalement
    // rejoint la correction admin, l'override devient inutile et disparaît.
    const nextOverride = computeOfficialMatchAdminOverride(sourceMatch, activeMatch);

    officialUpserts.push({
      id: matchId,
      clubId,
      date: activeMatch.date,
      time: activeMatch.time || '',
      sourceMatchId: activeMatch.sourceMatchId?.trim() || null,
      payload: serializeMatchPayload(activeMatch),
    });

    let nextExtras = { ...currentExtras, id: matchId };
    if (!previous) {
      createdCount += 1;
      nextExtras = { ...nextExtras, planningStatus: 'draft' };
    } else if (wasMissing || scheduleChanged(previous, activeMatch)) {
      updatedCount += 1;
      if (currentExtras.sourceMissingCancelled === true || isVisiblePlanningStatus(currentExtras.planningStatus)) {
        nextExtras = {
          ...nextExtras,
          planningStatus: 'modified',
          modifiedAfterPublishAt: observedAt,
          cancelledAt: null,
          cancellationReason: null,
          sourceMissingCancelled: false,
        };
        notifications.push({ match: activeMatch, extras: nextExtras, type: 'updated' });
      }
    }
    nextExtras = {
      ...nextExtras,
      sourceStatus: 'active',
      sourceLastSeenAt: observedAt,
      sourceMissingSince: null,
      sourceMissingObservations: 0,
      officialSourceSnapshot: sourceMatch,
      officialAdminOverride: hasOfficialMatchAdminOverride(nextOverride) ? nextOverride : null,
      officialOverrideDetectedAt: hasOfficialMatchAdminOverride(nextOverride)
        ? (currentExtras.officialOverrideDetectedAt ?? observedAt)
        : null,
    };
    extraUpserts.push({
      matchId,
      clubId,
      payload: serializeMatchExtrasPayload(nextExtras),
    });
  }

  let missingCount = 0;
  let pendingMissingCount = 0;
  for (const row of existingRows) {
    if (incomingById.has(row.id)) continue;
    const previous = parseMatchPayload(row.payload, 'MatchOfficial', { id: row.id, type: 'officiel' });
    const missingSince = previous.sourceMissingSince || observedAt;
    const missingObservation = nextSourceMissingObservation(previous);
    const missingObservations = missingObservation.count;
    const confirmedMissing = missingObservation.confirmed;
    const missingMatch: Match = {
      ...previous,
      sourceStatus: confirmedMissing ? ('missing' as const) : ('active' as const),
      sourceMissingSince: missingSince,
      sourceMissingObservations: missingObservations,
    };
    officialUpserts.push({
      id: row.id,
      clubId,
      date: row.date,
      time: row.time,
      sourceMatchId: previous.sourceMatchId?.trim() || null,
      payload: serializeMatchPayload(missingMatch),
    });
    if (confirmedMissing) missingCount += 1;
    else pendingMissingCount += 1;

    const currentExtras = extrasById.get(row.id) ?? { id: row.id };
    let nextExtras = {
      ...currentExtras,
      id: row.id,
      sourceStatus: confirmedMissing ? ('missing' as const) : ('active' as const),
      sourceMissingSince: missingSince,
      sourceMissingObservations: missingObservations,
    };
    if (
      confirmedMissing
      && previous.sourceStatus !== 'missing'
      && isVisiblePlanningStatus(currentExtras.planningStatus)
    ) {
      nextExtras = {
        ...nextExtras,
        planningStatus: 'cancelled' as const,
        cancelledAt: observedAt,
        cancellationReason: 'Match absent de la dernière source de scraping',
        sourceMissingCancelled: true,
      };
      notifications.push({ match: missingMatch, extras: nextExtras, type: 'cancelled' });
    }
    extraUpserts.push({
      matchId: row.id,
      clubId,
      payload: serializeMatchExtrasPayload(nextExtras),
    });
  }

  // TypeORM's deep-partial type cannot model arbitrary JSON payloads, while the schema can.
  if (officialUpserts.length > 0) await officialRepo.upsert(officialUpserts as never, ['id']);
  if (extraUpserts.length > 0) await extraRepo.upsert(extraUpserts as never, ['matchId']);
  await metaRepo.upsert([
    { key: clubMetaKey(CLUB_INFO_KEY, clubId), value: JSON.stringify(normalized.club) },
    { key: clubMetaKey(MATCHES_URL_KEY, clubId), value: normalized.url || '' },
    { key: clubMetaKey(MATCHES_SCRAPED_AT_KEY, clubId), value: observedAt },
  ], ['key']);

  return {
    activeCount: incomingById.size,
    createdCount,
    missingCount,
    notifications,
    pendingMissingCount,
    updatedCount,
  };
}

/**
 * Identifiant club pour l'import JSON legacy one-shot (fichiers `data/*.json`).
 * N'utilise jamais l'ALS : ce bootstrap s'exécute depuis `getDb()` avant toute requête HTTP (#376).
 * Le repli `APP_CLUB_ID` reste limité à ce chemin, pas au scoping métier (#333).
 */
export async function resolveLegacyJsonMigrationClubId(dataSource: DataSource): Promise<string> {
  const clubIds = await listActiveClubIds(dataSource);
  return clubIds[0] ?? process.env.APP_CLUB_ID?.trim() ?? 'afp';
}

async function migrateJsonData(dataSource: DataSource): Promise<void> {
  const metaRepo = dataSource.getRepository<AppMetaEntity>('AppMeta');
  const migrationFlag = await metaRepo.findOne({ where: { key: MIGRATION_KEY } });

  if (migrationFlag?.value === 'true') {
    return;
  }

  const clubId = await resolveLegacyJsonMigrationClubId(dataSource);
  const userRepo = dataSource.getRepository<UserEntity>('User');
  const clubsRepo = dataSource.getRepository<ClubEntity>('Club');
  const categoriesRepo = dataSource.getRepository<CategorieEntity>('Categorie');
  const stadesRepo = dataSource.getRepository<StadeEntity>('Stade');
  const entrainementsRepo = dataSource.getRepository<EntrainementEntity>('Entrainement');
  const plateauxRepo = dataSource.getRepository<PlateauEntity>('Plateau');
  const amicauxRepo = dataSource.getRepository<MatchAmicalEntity>('MatchAmical');
  const extrasRepo = dataSource.getRepository<MatchExtraEntity>('MatchExtra');

  const existingOfficiels = await userRepo.find({ where: { clubId } });
  if (!existingOfficiels.some((user) => (user.planningFunctions ?? []).includes('arbitre_club'))) {
    const json = readJsonFile<{ officiels: Array<{ nom: string; telephone?: string; indisponibilites?: unknown[] }> }>('data/officiels.json', { officiels: [] });
    for (const officiel of json.officiels) {
      if (!officiel.nom?.trim()) {
        continue;
      }
      const email = await generatePlaceholderEmail(dataSource, officiel.nom, 'officiel');
      const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
      await userRepo.save({
        clubId,
        email,
        passwordHash,
        nom: officiel.nom.trim(),
        accessRole: 'dirigeant',
        planningFunctions: ['arbitre_club'],
        active: true,
        // Profil importé sans accès (issue #204) : activation par invitation ciblée.
        claimedAt: null,
        telephone: officiel.telephone?.trim() || null,
        indisponibilites: normalizeIndisponibilites(officiel.indisponibilites),
        // Pas de flux iCal généré à l'import (issue #13) — voir
        // `app/lib/planning/ical-token.ts`.
      });
    }
  }

  if ((await clubsRepo.countBy({ clubId })) === 0) {
    const json = readJsonFile<Array<{ nom: string; logo: string }>>('data/clubs.json', []);
    const uniqueClubs = new Map<string, { nom: string; logo: string }>();

    for (const club of json) {
      if (!club.nom?.trim() || !club.logo?.trim()) {
        continue;
      }

      const nom = club.nom.trim();
      const logo = club.logo.trim();
      uniqueClubs.set(normalizeKey(nom), { nom, logo });
    }

    for (const club of uniqueClubs.values()) {
      await clubsRepo.save({ clubId, nom: club.nom, logo: club.logo });
    }
  }

  if ((await categoriesRepo.countBy({ clubId })) === 0) {
    const json = readJsonFile<{ categories: string[] }>('data/categories.json', { categories: [] });
    const uniqueValues = new Map<string, string>();

    for (const value of json.categories) {
      if (!value?.trim()) {
        continue;
      }

      const normalizedValue = value.trim();
      uniqueValues.set(normalizeKey(normalizedValue), normalizedValue);
    }

    for (const uniqueValue of uniqueValues.values()) {
      await categoriesRepo.save({ clubId, value: uniqueValue });
    }
  }

  if ((await stadesRepo.countBy({ clubId })) === 0) {
    const json = readJsonFile<{ stades: Array<{ nom: string; adresse: string | null; googleMapsUrl: string }> }>('stades.json', { stades: [] });
    for (const stade of json.stades) {
      if (!stade.nom?.trim() || !stade.googleMapsUrl?.trim()) {
        continue;
      }
      await stadesRepo.save({
        clubId,
        nom: stade.nom.trim(),
        adresse: stade.adresse?.trim() || null,
        googleMapsUrl: stade.googleMapsUrl.trim(),
      });
    }
  }

  if ((await entrainementsRepo.countBy({ clubId })) === 0) {
    const json = readJsonFile<{ entrainements: Record<string, Entrainement[]> }>('entrainements.json', { entrainements: {} });
    const flattened = flattenByDate(json.entrainements);
    for (const entrainement of flattened) {
      if (!entrainement?.id) {
        continue;
      }
      await entrainementsRepo.save({
        id: entrainement.id,
        clubId,
        date: entrainement.date,
        time: entrainement.time || '',
        payload: normalizeLegacyPlanningPayload(entrainement as unknown as Record<string, unknown>),
      });
    }
  }

  if ((await plateauxRepo.countBy({ clubId })) === 0) {
    const json = readJsonFile<{ plateaux: Record<string, Plateau[]> }>('plateaux.json', { plateaux: {} });
    const flattened = flattenByDate(json.plateaux);
    for (const plateau of flattened) {
      if (!plateau?.id) {
        continue;
      }
      await plateauxRepo.save({
        id: plateau.id,
        clubId,
        date: plateau.date,
        time: plateau.time || '',
        payload: normalizeLegacyPlanningPayload(plateau as unknown as Record<string, unknown>),
      });
    }
  }

  if ((await amicauxRepo.countBy({ clubId })) === 0) {
    const json = readJsonFile<MatchesAmicauxData>('matches-amicaux.json', { matches: {} });
    const flattened = flattenByDate(json.matches);
    for (const match of flattened) {
      if (!match?.id) {
        continue;
      }
      await amicauxRepo.save({
        id: match.id,
        clubId,
        date: match.date,
        time: match.time || '',
        payload: match as unknown as Record<string, unknown>,
      });
    }
  }

  if ((await extrasRepo.countBy({ clubId })) === 0) {
    const json = readJsonFile<Record<string, { id: string }>>('matches-extras.json', {});
    for (const [matchId, payload] of Object.entries(json)) {
      await extrasRepo.save({
        matchId,
        clubId,
        payload: normalizeLegacyPlanningPayload(payload as unknown as Record<string, unknown>),
      });
    }
  }

  if ((await dataSource.getRepository<MatchOfficialEntity>('MatchOfficial').countBy({ clubId })) === 0) {
    const json = readJsonFile<MatchesData>('matches.json', {
      club: { name: 'Academie Football Paris 18', description: 'Club de Football à Paris 18', logo: '' },
      url: '',
      scrapedAt: new Date().toISOString(),
      matches: {},
    });
    const hasSomeMatch = Object.values(json.matches).some((items) => Array.isArray(items) && items.length > 0);
    if (hasSomeMatch) {
      await syncOfficialMatchesData(dataSource, json, clubId);
    } else {
      await metaRepo.save({ key: clubMetaKey(CLUB_INFO_KEY, clubId), value: JSON.stringify(json.club) });
      await metaRepo.save({ key: clubMetaKey(MATCHES_URL_KEY, clubId), value: json.url || '' });
      await metaRepo.save({ key: clubMetaKey(MATCHES_SCRAPED_AT_KEY, clubId), value: json.scrapedAt || new Date().toISOString() });
    }
  }

  await metaRepo.save({ key: MIGRATION_KEY, value: 'true' });
}

async function migrateLegacyPlanningStatuses(dataSource: DataSource): Promise<void> {
  const metaRepo = dataSource.getRepository<AppMetaEntity>('AppMeta');
  const flag = await metaRepo.findOne({ where: { key: PLANNING_STATUS_MIGRATION_KEY } });
  if (flag?.value === 'true') return;

  const extrasRepo = dataSource.getRepository<MatchExtraEntity>('MatchExtra');
  const trainingRepo = dataSource.getRepository<EntrainementEntity>('Entrainement');
  const plateauRepo = dataSource.getRepository<PlateauEntity>('Plateau');
  const officialRepo = dataSource.getRepository<MatchOfficialEntity>('MatchOfficial');
  const amicalRepo = dataSource.getRepository<MatchAmicalEntity>('MatchAmical');

  const [extrasRows, trainingRows, plateauRows, officialRows, amicalRows] = await Promise.all([
    extrasRepo.find(),
    trainingRepo.find(),
    plateauRepo.find(),
    officialRepo.find(),
    amicalRepo.find(),
  ]);

  const extrasByKey = new Map(extrasRows.map((row) => [`${row.clubId}:${row.matchId}`, row]));
  for (const row of extrasRows) {
    const next = normalizeLegacyPlanningPayload(row.payload);
    if (next.planningStatus !== row.payload.planningStatus) {
      row.payload = next;
      await extrasRepo.save(row);
    }
  }

  // Un match legacy peut même ne pas avoir de ligne MatchExtra : on en crée une
  // explicitement en brouillon pour supprimer toute ambiguïté.
  for (const row of [...officialRows, ...amicalRows]) {
    const key = `${row.clubId}:${row.id}`;
    if (extrasByKey.has(key)) continue;
    const created = await extrasRepo.save({
      matchId: row.id,
      clubId: row.clubId,
      payload: { id: row.id, planningStatus: 'draft' },
    });
    extrasByKey.set(key, created);
  }

  for (const row of trainingRows) {
    const next = normalizeLegacyPlanningPayload(row.payload);
    if (next.planningStatus !== row.payload.planningStatus) {
      row.payload = next;
      await trainingRepo.save(row);
    }
  }
  for (const row of plateauRows) {
    const next = normalizeLegacyPlanningPayload(row.payload);
    if (next.planningStatus !== row.payload.planningStatus) {
      row.payload = next;
      await plateauRepo.save(row);
    }
  }

  await metaRepo.save({ key: PLANNING_STATUS_MIGRATION_KEY, value: 'true' });
}

export async function ensureJsonDataMigrated(dataSource: DataSource): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  let lockAcquired = false;
  try {
    const rows = await runner.query(
      'SELECT GET_LOCK(?, 15) AS acquired',
      [JSON_MIGRATION_LOCK],
    ) as Array<{ acquired?: number | string }>;
    lockAcquired = Number(rows[0]?.acquired) === 1;
    if (!lockAcquired) throw new Error('Migration initiale de la base déjà en cours');
    await migrateJsonData(dataSource);
    await migrateLegacyPlanningStatuses(dataSource);
  } finally {
    if (lockAcquired) await runner.query('SELECT RELEASE_LOCK(?)', [JSON_MIGRATION_LOCK]);
    await runner.release();
  }
}

export async function getOfficialMatchesMeta(dataSource: DataSource, clubId: string): Promise<{
  club: { name: string; description: string; logo: string };
  url: string;
  scrapedAt: string;
}> {
  const metaRepo = dataSource.getRepository<AppMetaEntity>('AppMeta');
  const [clubMeta, urlMeta, scrapedAtMeta] = await Promise.all([
    metaRepo.findOne({ where: { key: clubMetaKey(CLUB_INFO_KEY, clubId) } }),
    metaRepo.findOne({ where: { key: clubMetaKey(MATCHES_URL_KEY, clubId) } }),
    metaRepo.findOne({ where: { key: clubMetaKey(MATCHES_SCRAPED_AT_KEY, clubId) } }),
  ]);

  const fallbackClub = {
    name: 'Academie Football Paris 18',
    description: 'Club de Football à Paris 18',
    logo: '',
  };

  let club = fallbackClub;
  if (clubMeta?.value) {
    try {
      club = JSON.parse(clubMeta.value) as typeof fallbackClub;
    } catch {
      club = fallbackClub;
    }
  }

  return {
    club,
    url: urlMeta?.value ?? '',
    scrapedAt: scrapedAtMeta?.value ?? new Date().toISOString(),
  };
}

