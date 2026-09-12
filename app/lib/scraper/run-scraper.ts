import { execFile } from 'child_process';
import { createHash } from 'node:crypto';
import path from 'path';
import { promisify } from 'util';
import { getDb } from '@/lib/db';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import type { MatchesData } from '@/types/match';
import { getCurrentClubId, setCurrentClubId } from '@/lib/auth/club-context';
import {
  compactClubIdentity,
  isHomeMatchForClub,
  normalizeClubIdentity,
  teamNameMatchesClub,
} from './club-identity';
import { syncOfficialMatchesWithIdentityReconciliation } from './match-reconciliation';
import { deliverOfficialMatchSyncNotifications } from './match-sync-notifications';
import { parseScraperOutput } from './output';
import { failScraperRun, finishScraperRun, startScraperRun } from './runs';

const execFileAsync = promisify(execFile);
const MATCHES_URL_KEY_PATTERN = /^[a-z0-9-]{1,255}$/;

interface ScraperSourceConfig {
  matchesUrlKey: string;
  scraperClubName: string;
}

export {
  compactClubIdentity,
  isHomeMatchForClub,
  normalizeClubIdentity,
  teamNameMatchesClub,
};

export async function getScraperSourceConfig(clubId: string): Promise<ScraperSourceConfig> {
  const db = await getDb();
  const tenant = await db
    .getRepository<ClubTenantEntity>('ClubTenant')
    .findOneBy({ id: clubId, active: true });

  if (!tenant) {
    throw new Error('Club introuvable ou désactivé pour le scraping');
  }

  const matchesUrlKey = tenant.matchesUrlKey.trim().toLowerCase();
  if (!MATCHES_URL_KEY_PATTERN.test(matchesUrlKey)) {
    throw new Error('Source de scraping non configurée ou invalide pour ce club dans /plateforme');
  }

  const scraperClubName = tenant.scraperClubName.trim();
  // Issue #221 : scraperClubName vide désactivait silencieusement assertScrapedClubIdentity
  // ci-dessous. La validation à la création/mise à jour du club (/api/plateforme/clubs)
  // empêche déjà ce cas pour toute nouvelle configuration ; ce garde-fou couvre aussi les
  // configurations existantes créées avant cette validation.
  if (!scraperClubName) {
    throw new Error('scraperClubName non configuré pour ce club dans /plateforme : vérification d\'identité impossible');
  }

  return { matchesUrlKey, scraperClubName };
}

export function assertScrapedClubIdentity(config: ScraperSourceConfig, parsed: MatchesData): void {
  const actualName = parsed.club?.name ?? '';
  const expected = normalizeClubIdentity(config.scraperClubName);
  const actual = normalizeClubIdentity(actualName);
  if (expected && actual && expected === actual) return;

  // Repli tolérant : le nom saisi, le nom réel de la page et la clé d'URL SportCorico
  // s'écrivent souvent avec un espacement de sigle différent (« A-S » / « AS » /
  // « a-s-de-… »). On accepte alors une correspondance sur la forme alphanumérique
  // compacte, avec le nom configuré ET avec la clé d'URL (identifiant réel de la source).
  const actualCompact = compactClubIdentity(actualName);
  const compactCandidates = [config.scraperClubName, config.matchesUrlKey]
    .map(compactClubIdentity)
    .filter((candidate) => candidate.length > 0);
  if (actualCompact && compactCandidates.includes(actualCompact)) return;

  throw new Error('La source de scraping ne correspond pas au club configuré par la plateforme');
}

function scraperRunLockName(clubId: string): string {
  const clubDigest = createHash('sha256').update(clubId).digest('hex').slice(0, 32);
  return `clubika_scraper_${clubDigest}`;
}


export async function runScraperAndPersistToDb(clubId: string = getCurrentClubId()): Promise<{
  runId: string;
  stdout: string;
  stderr: string;
  sync: {
    activeCount: number;
    createdCount: number;
    missingCount: number;
    pendingMissingCount: number;
    updatedCount: number;
  };
}> {
  const scraperPath = path.join(process.cwd(), 'scraper.js');
  const db = await getDb();
  const lockRunner = db.createQueryRunner();
  const lockName = scraperRunLockName(clubId);
  let lockAcquired = false;

  await lockRunner.connect();
  try {
    const lockRows = await lockRunner.query(
      'SELECT GET_LOCK(?, 0) AS acquired',
      [lockName],
    ) as Array<{ acquired?: number | string }>;
    lockAcquired = Number(lockRows[0]?.acquired) === 1;
    if (!lockAcquired) {
      throw new Error('Un scraping est déjà en cours pour ce club');
    }

    const sourceConfig = await getScraperSourceConfig(clubId);
    const runId = await startScraperRun(db, clubId);
    try {
      // scraper.js importe le client/mapper TypeScript des API club et match SportCorico.
      const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', scraperPath], {
        cwd: process.cwd(),
        timeout: 120000,
        env: {
          ...process.env,
          SCRAPER_MATCHES_URL_KEY: sourceConfig.matchesUrlKey,
          SCRAPER_CLUB_NAME: sourceConfig.scraperClubName,
        },
        maxBuffer: 20 * 1024 * 1024,
      });
      const parsed: MatchesData = parseScraperOutput(stdout);
      assertScrapedClubIdentity(sourceConfig, parsed);
      setCurrentClubId(clubId);
      const syncResult = await syncOfficialMatchesWithIdentityReconciliation(db, parsed, clubId);
      await deliverOfficialMatchSyncNotifications(db, clubId, syncResult.notifications);

      const sync = {
        activeCount: syncResult.activeCount,
        createdCount: syncResult.createdCount,
        missingCount: syncResult.missingCount,
        pendingMissingCount: syncResult.pendingMissingCount,
        updatedCount: syncResult.updatedCount,
      };
      await finishScraperRun(db, runId, sync);
      return {
        runId,
        stdout,
        stderr,
        sync,
      };
    } catch (error) {
      await failScraperRun(db, runId, error);
      throw error;
    }
  } finally {
    if (lockAcquired) {
      try {
        await lockRunner.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch (error) {
        console.error('Impossible de libérer le verrou du scraper:', error);
      }
    }
    await lockRunner.release();
  }
}
