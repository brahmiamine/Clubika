import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import type { UserEntity } from '@/lib/db/schemas';
import { backfillUnclaimedProfiles } from './unclaimed-profiles';

const dbAvailable = await isDbAvailable();

describe('migration 0012 — base neuve', () => {
  it("ignore le backfill lorsque la table users n'existe pas encore", async () => {
    const query = vi.fn().mockResolvedValueOnce([]);
    const affected = await backfillUnclaimedProfiles({ query } as unknown as Awaited<ReturnType<typeof getDb>>);

    expect(affected).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('information_schema.tables'));
  });
});

describe.skipIf(!dbAvailable)('migration 0012 — backfillUnclaimedProfiles (issue #204)', () => {
  it('marque activés les comptes à email réel, préserve les profils techniques, et se rejoue sans effet', async () => {
    const db = await getDb();
    const userRepo = db.getRepository<UserEntity>('User');
    const tag = randomBytes(6).toString('hex');
    const base = {
      clubId: `test-club-${tag}`,
      passwordHash: 'hash',
      planningFunctions: [] as string[],
      active: true,
      // Lignes simulées « pré-migration » : claimedAt absent.
      claimedAt: null,
      accessRole: 'dirigeant',
    };
    const realAccount = await userRepo.save({
      ...base,
      email: `claimed-${tag}@example.com`,
      nom: 'Compte Réel',
    });
    const placeholder = await userRepo.save({
      ...base,
      email: `profil.${tag}.officiel@sans-acces.local`,
      nom: 'Profil Technique',
      planningFunctions: ['arbitre_club'],
    });

    try {
      await backfillUnclaimedProfiles(db);

      const realAfter = await userRepo.findOneBy({ id: realAccount.id });
      const placeholderAfter = await userRepo.findOneBy({ id: placeholder.id });
      expect(realAfter?.claimedAt).not.toBeNull();
      expect(placeholderAfter?.claimedAt).toBeNull();

      // Rejouable : la seconde exécution ne réécrit aucune ligne.
      const firstClaimedAt = realAfter?.claimedAt;
      await backfillUnclaimedProfiles(db);
      const realSecondPass = await userRepo.findOneBy({ id: realAccount.id });
      expect(new Date(realSecondPass?.claimedAt as Date).getTime())
        .toBe(new Date(firstClaimedAt as Date).getTime());
      expect((await userRepo.findOneBy({ id: placeholder.id }))?.claimedAt).toBeNull();
    } finally {
      await userRepo.delete({ id: realAccount.id });
      await userRepo.delete({ id: placeholder.id });
    }
  });
});
