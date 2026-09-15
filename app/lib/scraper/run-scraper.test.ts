import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import { SPORTCORICO_SYNC_DISABLED_MESSAGE } from './sync-gate';

let tenant: Partial<ClubTenantEntity> | null = null;
vi.mock('@/lib/db', () => ({
  getDb: async () => ({
    getRepository: () => ({ findOneBy: async () => tenant }),
  }),
}));

const {
  assertScrapedClubIdentity,
  getScraperSourceConfig,
  isHomeMatchForClub,
  runScraperAndPersistToDb,
  teamNameMatchesClub,
} = await import('./run-scraper');

describe('assertScrapedClubIdentity (issue #221)', () => {
  it('bloque un club scrapé différent même quand scraperClubName serait vide', () => {
    // Avant #221, une chaîne vide désactivait silencieusement toute vérification.
    expect(() => assertScrapedClubIdentity(
      { matchesUrlKey: 'afp', scraperClubName: '' },
      { club: { name: 'Un autre club' } } as never,
    )).toThrow('ne correspond pas au club configuré');
  });

  it('accepte une correspondance exacte (à la casse/accents près)', () => {
    expect(() => assertScrapedClubIdentity(
      { matchesUrlKey: 'afp', scraperClubName: 'Académie Football Paris 18' },
      { club: { name: 'academie football paris 18' } } as never,
    )).not.toThrow();
  });

  it('tolère un espacement de sigle différent entre nom saisi, clé d’URL et nom réel', () => {
    // scraperClubName recopie la clé d'URL (« a-s-de-… ») ; la page renvoie « AS de Football Tallard ».
    expect(() => assertScrapedClubIdentity(
      { matchesUrlKey: 'a-s-de-football-tallard', scraperClubName: 'a-s-de-football-tallard' },
      { club: { name: 'AS de Football Tallard' } } as never,
    )).not.toThrow();
  });

  it('accepte quand seule la clé d’URL correspond au club scrapé', () => {
    expect(() => assertScrapedClubIdentity(
      { matchesUrlKey: 'as-de-football-tallard', scraperClubName: 'Ancien nom obsolète' },
      { club: { name: 'A.S. de Football Tallard' } } as never,
    )).not.toThrow();
  });

  it('refuse toujours un club scrapé étranger malgré le repli compact', () => {
    expect(() => assertScrapedClubIdentity(
      { matchesUrlKey: 'a-s-de-football-tallard', scraperClubName: 'a-s-de-football-tallard' },
      { club: { name: 'Olympique de Marseille' } } as never,
    )).toThrow('ne correspond pas au club configuré');
  });
});

describe('scraper club identity matching (issue #335)', () => {
  it('reconnaît le club configuré dans un nom d’équipe ou un alt de logo', () => {
    expect(teamNameMatchesClub('AFP 18 U13 F-1', 'Académie Football Paris 18')).toBe(true);
    expect(teamNameMatchesClub('AS de Football Tallard', 'A-S de Football Tallard')).toBe(true);
    expect(teamNameMatchesClub('Olympique de Marseille', 'Académie Football Paris 18')).toBe(false);
  });

  it('détermine le domicile/extérieur à partir du club configuré, pas d’AFP en dur', () => {
    expect(isHomeMatchForClub('AS de Football Tallard', 'AS de Football Tallard')).toBe(true);
    expect(isHomeMatchForClub('Visiteur FC', 'AS de Football Tallard')).toBe(false);
  });
});

describe('runScraperAndPersistToDb kill switch (issue #4)', () => {
  const previous = process.env.SPORTCORICO_SYNC_ENABLED;

  afterEach(() => {
    if (previous === undefined) delete process.env.SPORTCORICO_SYNC_ENABLED;
    else process.env.SPORTCORICO_SYNC_ENABLED = previous;
  });

  it('n’acquiert aucun verrou ni processus lorsque le kill switch est fermé', async () => {
    delete process.env.SPORTCORICO_SYNC_ENABLED;
    await expect(runScraperAndPersistToDb('afp')).rejects.toThrow(SPORTCORICO_SYNC_DISABLED_MESSAGE);
  });
});

describe('getScraperSourceConfig (issue #221)', () => {
  it("refuse un club dont matchesUrlKey est configuré sans scraperClubName", async () => {
    tenant = { matchesUrlKey: 'afp', scraperClubName: '', active: true } as ClubTenantEntity;
    await expect(getScraperSourceConfig('afp')).rejects.toThrow('scraperClubName non configuré');
  });

  it('accepte un club correctement configuré', async () => {
    tenant = { matchesUrlKey: 'afp', scraperClubName: 'AFP', active: true } as ClubTenantEntity;
    await expect(getScraperSourceConfig('afp')).resolves.toEqual({
      matchesUrlKey: 'afp',
      scraperClubName: 'AFP',
    });
  });
});
