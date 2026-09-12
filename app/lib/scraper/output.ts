import type { MatchesData } from '@/types/match';

export const SCRAPER_RESULT_PREFIX = '__CLUBIKA_SCRAPER_RESULT__=';

function isMatchesData(value: unknown): value is MatchesData {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MatchesData>;
  return Boolean(
    candidate.club
    && typeof candidate.club.name === 'string'
    && typeof candidate.url === 'string'
    && typeof candidate.scrapedAt === 'string'
    && candidate.matches
    && typeof candidate.matches === 'object',
  );
}

export function parseScraperOutput(stdout: string): MatchesData {
  const line = stdout
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(SCRAPER_RESULT_PREFIX));
  if (!line) throw new Error('Le scraper a terminé sans résultat structuré');

  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(SCRAPER_RESULT_PREFIX.length));
  } catch {
    throw new Error('Le résultat structuré du scraper est invalide');
  }
  if (!isMatchesData(parsed)) throw new Error('Le résultat structuré du scraper est incomplet');
  return parsed;
}
