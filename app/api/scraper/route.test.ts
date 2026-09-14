import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getDb: vi.fn(),
  planningFeatureGuard: vi.fn(),
  runScraperAndPersistToDb: vi.fn(),
  listScraperRuns: vi.fn(),
  setCurrentClubId: vi.fn(),
}));

vi.mock('@/lib/auth/require', () => ({ requireRole: mocks.requireRole }));
vi.mock('@/lib/db', () => ({ getDb: mocks.getDb }));
vi.mock('@/lib/planning/feature-guard', () => ({ planningFeatureGuard: mocks.planningFeatureGuard }));
vi.mock('@/lib/scraper/run-scraper', () => ({
  runScraperAndPersistToDb: mocks.runScraperAndPersistToDb,
}));
vi.mock('@/lib/scraper/runs', () => ({ listScraperRuns: mocks.listScraperRuns }));
vi.mock('@/lib/auth/club-context', () => ({ setCurrentClubId: mocks.setCurrentClubId }));

import { POST } from './route';

const user = {
  id: 7,
  clubId: 'club-test',
  accessRole: 'admin',
  planningFunctions: [],
  email: 'admin@example.com',
  nom: 'Admin',
};

function request() {
  return new NextRequest('http://localhost/api/scraper', { method: 'POST' });
}

describe('POST /api/scraper — SEC-007 error details', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ user });
    mocks.getDb.mockResolvedValue({});
    mocks.planningFeatureGuard.mockResolvedValue(null);
  });

  it('does not echo internal error details on a 500', async () => {
    mocks.runScraperAndPersistToDb.mockRejectedValue(
      new Error('ECONNREFUSED mysql://root:super-secret@db:3306/clubika'),
    );

    const response = await POST(request());
    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.error).toBe('Failed to run scraper');
    expect(body).not.toHaveProperty('details');
    expect(JSON.stringify(body)).not.toContain('super-secret');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });
});
