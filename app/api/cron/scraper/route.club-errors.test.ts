import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  runScraperAndPersistToDb: vi.fn(),
  planningFeatureGuard: vi.fn(),
  listActiveClubIds: vi.fn(),
  runWithClubId: vi.fn(async (_clubId: string, work: () => Promise<void>) => work()),
}));

vi.mock('@/lib/db', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/scraper/run-scraper', () => ({
  runScraperAndPersistToDb: mocks.runScraperAndPersistToDb,
}));
vi.mock('@/lib/planning/feature-guard', () => ({ planningFeatureGuard: mocks.planningFeatureGuard }));
vi.mock('@/lib/db/club-tenants', () => ({ listActiveClubIds: mocks.listActiveClubIds }));
vi.mock('@/lib/auth/club-context', () => ({ runWithClubId: mocks.runWithClubId }));

import { POST } from './route';

function cronRequest(headers?: HeadersInit) {
  return new NextRequest('http://localhost/api/cron/scraper', {
    method: 'POST',
    headers,
  });
}

describe('POST /api/cron/scraper — per-club error sanitization', () => {
  const previousSecret = process.env.CRON_SECRET;

  afterEach(() => {
    mocks.getDb.mockReset();
    mocks.runScraperAndPersistToDb.mockReset();
    mocks.planningFeatureGuard.mockReset();
    mocks.listActiveClubIds.mockReset();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  it('does not echo internal exception messages in per-club results', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    mocks.getDb.mockResolvedValue({});
    mocks.listActiveClubIds.mockResolvedValue(['club-a']);
    mocks.planningFeatureGuard.mockResolvedValue(null);
    mocks.runScraperAndPersistToDb.mockRejectedValue(
      new Error('ECONNREFUSED mysql://root:super-secret@db:3306/clubika'),
    );

    const response = await POST(cronRequest({ authorization: 'Bearer expected-secret' }));
    expect(response.status).toBe(200);
    const body = await response.json() as {
      success: boolean;
      results: Array<{ clubId: string; error?: string }>;
    };
    expect(body.success).toBe(true);
    expect(body.results).toEqual([{ clubId: 'club-a', error: 'Scraping failed' }]);
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });
});
