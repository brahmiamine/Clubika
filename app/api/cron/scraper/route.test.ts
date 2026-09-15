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

describe('POST /api/cron/scraper — kill switch (issue #4)', () => {
  const previousSecret = process.env.CRON_SECRET;
  const previousSync = process.env.SPORTCORICO_SYNC_ENABLED;

  afterEach(() => {
    mocks.runScraperAndPersistToDb.mockReset();
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
    if (previousSync === undefined) delete process.env.SPORTCORICO_SYNC_ENABLED;
    else process.env.SPORTCORICO_SYNC_ENABLED = previousSync;
  });

  it('accepte un secret valide et n’appelle pas le scraper tant que le verrou global est fermé', async () => {
    delete process.env.SPORTCORICO_SYNC_ENABLED;
    process.env.CRON_SECRET = 'expected-secret';
    mocks.runScraperAndPersistToDb.mockResolvedValue({ runId: 'mock-run', sync: { mocked: true } });

    const response = await POST(cronRequest({ authorization: 'Bearer expected-secret' }));
    expect(response.status).toBe(200);
    const body = await response.json() as { success: boolean; disabled?: boolean; results: unknown[] };
    expect(body.success).toBe(true);
    expect(body.disabled).toBe(true);
    expect(body.results).toEqual([]);
    expect(mocks.runScraperAndPersistToDb).not.toHaveBeenCalled();
  });
});

describe.skipIf(!dbAvailable)('POST /api/cron/scraper (issue #286)', () => {
  const previousSecret = process.env.CRON_SECRET;

  afterEach(() => {
    mocks.runScraperAndPersistToDb.mockReset();
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
});
