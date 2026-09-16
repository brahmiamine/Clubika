#!/usr/bin/env npx tsx
/**
 * Après restauration d'une sauvegarde, rejoue la purge des clubs déjà
 * tombstonés (offboardingStatus = purged) pour empêcher la remise en
 * production de données personnelles d'un tenant supprimé.
 *
 * Dry-run par défaut. Purge réelle : ENFORCE_TOMBSTONES=1
 *
 * Usage :
 *   pnpm tsx scripts/enforce-tenant-tombstones.ts
 *   ENFORCE_TOMBSTONES=1 pnpm tsx scripts/enforce-tenant-tombstones.ts
 */
import { getDb } from '../app/lib/db';
import { purgeClub } from '../app/lib/tenant-offboarding/purge';

async function main() {
  const dryRun = process.env.ENFORCE_TOMBSTONES !== '1';
  const db = await getDb();
  const rows = await db.query(
    "SELECT id FROM club_tenants WHERE offboardingStatus = 'purged'",
  ) as Array<{ id: string }>;
  const reports = [];
  for (const row of rows) {
    reports.push(await purgeClub(db, row.id, {
      dryRun,
      overrideRetention: true,
      confirmClubId: dryRun ? undefined : row.id,
      platformAdminId: null,
    }));
  }
  process.stdout.write(`${JSON.stringify({ dryRun, clubs: rows.length, reports }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
