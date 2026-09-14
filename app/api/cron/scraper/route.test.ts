import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';

const mocks = vi.hoisted(() => ({
  runScraperAndPersistToDb: vi.fn(),
}));

vi.mock('@/lib/scraper/run-scraper', () => ({
  runScraperAndPersistToDb: mocks.runScraperAndPersistToDb,
}));

import { POST } from './route';

const dbAvailable = await isDbAvailable();

function cronRequest(headers?: HeadersInit, url = 'http://localhost/api/cron/scraper') {
  return new NextRequest(url, {
    method: 'POST',
    headers,
  });
}

describe.skipIf(!dbAvailable)('POST /api/cron/scraper (issue #286)', () => {
  const previousSecret = process.env.CRON_SECRET;

  afterEach(() => {
    mocks.runScraperAndPersistToDb.mockReset();
    vi.unstubAllEnvs();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  it('rejects a missing or invalid secret', async () => {
    delete process.env.CRON_SECRET;
    expect((await POST(cronRequest())).status).toBe(401);

    process.env.CRON_SECRET = 'expected-secret';
    expect((await POST(cronRequest({ authorization: 'Bearer other-secret' }))).status).toBe(401);
    expect((await POST(cronRequest({ 'x-cron-secret': 'expected-secret' }))).status).toBe(401);
    expect((await POST(cronRequest(undefined, 'http://localhost/api/cron/scraper?secret=expected-secret'))).status).toBe(401);
  });

  it('refuse le scrape tant que SPORTCORICO_SYNC_ENABLED n’est pas true', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    mocks.runScraperAndPersistToDb.mockResolvedValue({ runId: 'mock-run', sync: { mocked: true } });

    const response = await POST(cronRequest({ authorization: 'Bearer expected-secret' }));
    expect(response.status).toBe(409);
    expect(mocks.runScraperAndPersistToDb).not.toHaveBeenCalled();
  });

  it('accepts a valid secret and never calls the live scraper from this test', async () => {
    process.env.CRON_SECRET = 'expected-secret';
    vi.stubEnv('SPORTCORICO_SYNC_ENABLED', 'true');
    mocks.runScraperAndPersistToDb.mockResolvedValue({ runId: 'mock-run', sync: { mocked: true } });

    const response = await POST(cronRequest({ authorization: 'Bearer expected-secret' }));
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; results: unknown[] };
    expect(body.success).toBe(true);
    expect(Array.isArray(body.results)).toBe(true);
  });
});
