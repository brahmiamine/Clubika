import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SPORTCORICO_SYNC_DISABLED_MESSAGE } from '@/lib/scraper/sync-gate';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  runScraperAndPersistToDb: vi.fn(),
  planningFeatureGuard: vi.fn(),
  getDb: vi.fn(),
  listScraperRuns: vi.fn(),
  setCurrentClubId: vi.fn(),
}));

vi.mock('@/lib/auth/require', () => ({
  requireRole: mocks.requireRole,
}));
vi.mock('@/lib/scraper/run-scraper', () => ({
  runScraperAndPersistToDb: mocks.runScraperAndPersistToDb,
}));
vi.mock('@/lib/planning/feature-guard', () => ({
  planningFeatureGuard: mocks.planningFeatureGuard,
}));
vi.mock('@/lib/db', () => ({
  getDb: mocks.getDb,
}));
vi.mock('@/lib/scraper/runs', () => ({
  listScraperRuns: mocks.listScraperRuns,
}));
vi.mock('@/lib/auth/club-context', () => ({
  setCurrentClubId: mocks.setCurrentClubId,
}));

const { POST } = await import('./route');

function scraperRequest() {
  return new NextRequest('http://localhost/api/scraper', { method: 'POST' });
}

describe('POST /api/scraper (issue #4)', () => {
  const previous = process.env.SPORTCORICO_SYNC_ENABLED;

  afterEach(() => {
    mocks.requireRole.mockReset();
    mocks.runScraperAndPersistToDb.mockReset();
    mocks.planningFeatureGuard.mockReset();
    if (previous === undefined) delete process.env.SPORTCORICO_SYNC_ENABLED;
    else process.env.SPORTCORICO_SYNC_ENABLED = previous;
  });

  it('refuse le lancement et n’appelle pas le scraper lorsque le verrou global est fermé', async () => {
    delete process.env.SPORTCORICO_SYNC_ENABLED;
    mocks.requireRole.mockResolvedValue({ user: { id: 1, clubId: 'afp', accessRole: 'admin' } });

    const response = await POST(scraperRequest());
    const body = await response.json() as { error: string; details?: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe(SPORTCORICO_SYNC_DISABLED_MESSAGE);
    expect(body).not.toHaveProperty('details');
    expect(mocks.runScraperAndPersistToDb).not.toHaveBeenCalled();
    expect(mocks.planningFeatureGuard).not.toHaveBeenCalled();
  });
});
