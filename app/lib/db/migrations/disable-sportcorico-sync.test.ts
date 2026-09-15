import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import { disableScraperSyncOnAllClubs } from './disable-sportcorico-sync';

const dbAvailable = await isDbAvailable();

describe('migration 0025 — table absente', () => {
  it('ne fait rien lorsque club_tenants n’existe pas encore', async () => {
    const query = vi.fn().mockResolvedValueOnce([]);
    const affected = await disableScraperSyncOnAllClubs({ query } as never);

    expect(affected).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('information_schema.tables'));
  });
});

describe.skipIf(!dbAvailable)('migration 0025 — disableScraperSyncOnAllClubs (issue #4)', () => {
  it('force scraperSync à false et se rejoue sans effet', async () => {
    const db = await getDb();
    const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const id = `test-club-${randomBytes(6).toString('hex')}`;
    await repo.save({
      id,
      name: 'Club test scraper',
      abbreviation: 'CTS',
      description: '',
      logo: '',
      themeMode: 'system',
      primaryColor: '#000000',
      secondaryColor: '#ffffff',
      timeZone: 'Europe/Paris',
      matchesUrlKey: 'demo-club',
      scraperClubName: 'Demo',
      featuresJson: JSON.stringify({ scraperSync: true, automaticReminders: true }),
      smtpSecure: false,
      active: true,
    });

    try {
      const first = await disableScraperSyncOnAllClubs(db);
      expect(first).toBeGreaterThanOrEqual(1);

      const after = await repo.findOneBy({ id });
      const features = JSON.parse(after?.featuresJson || '{}') as { scraperSync: boolean; automaticReminders: boolean };
      expect(features.scraperSync).toBe(false);
      expect(features.automaticReminders).toBe(true);

      await disableScraperSyncOnAllClubs(db);
      const replay = JSON.parse((await repo.findOneBy({ id }))?.featuresJson || '{}') as { scraperSync: boolean };
      expect(replay.scraperSync).toBe(false);
    } finally {
      await repo.delete({ id });
    }
  });
});
