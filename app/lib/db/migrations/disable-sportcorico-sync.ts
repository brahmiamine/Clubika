import type { DataSource } from 'typeorm';

/**
 * Migration 0025 (issue #4) — coupe le flag club `scraperSync` sur tous les
 * tenants existants. Les clubs nouveaux héritent déjà de la valeur par défaut
 * `false`. Rejouable : une ligne déjà à `false` n’est pas réécrite.
 *
 * Ne touche pas aux données importées (nettoyage = ticket #5).
 */
export async function disableScraperSyncOnAllClubs(db: DataSource): Promise<number> {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name = 'club_tenants' LIMIT 1`,
  ) as unknown[];
  if (rows.length === 0) return 0;

  const tenants = await db.query(
    'SELECT id, featuresJson FROM club_tenants',
  ) as Array<{ id: string; featuresJson: string | null }>;

  let updated = 0;
  for (const tenant of tenants) {
    let features: Record<string, unknown> = {};
    try {
      features = JSON.parse(tenant.featuresJson || '{}') as Record<string, unknown>;
    } catch {
      features = {};
    }
    if (features.scraperSync === false) continue;
    features.scraperSync = false;
    await db.query(
      'UPDATE club_tenants SET featuresJson = ? WHERE id = ?',
      [JSON.stringify(features), tenant.id],
    );
    updated += 1;
  }
  return updated;
}
