import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('scraper storage policy', () => {
  it('does not write scraped or statistical data to a JSON file', () => {
    const source = readFileSync(path.join(process.cwd(), 'scraper.js'), 'utf8');

    expect(source).not.toMatch(/writeFile(?:Sync)?\s*\(/);
    expect(source).not.toContain('matches.json');
    expect(source).toContain('__CLUBIKA_SCRAPER_RESULT__=');
    expect(source).toContain('loadSportCoricoClubPlanning');
    expect(source).not.toContain('parseMatchDetails');
    expect(source).not.toContain('playwright');
    expect(source).not.toContain('chromium');
  });
});
