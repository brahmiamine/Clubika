/**
 * Quarantaine des données SportCorico déjà importées (issue #5).
 *
 * Usage :
 *   # dry-run (compteurs uniquement)
 *   pnpm run sportcorico:quarantine
 *
 *   # écritures, après sauvegarde MariaDB
 *   SPORTCORICO_DATA_PURGE=apply pnpm run sportcorico:quarantine
 *
 * Ne jamais lancer `apply` depuis une pull request ni sur une base réelle
 * sans dump préalable. Voir docs/sportcorico-data-quarantine.md.
 */
import { getDataSource } from '../app/lib/db/data-source';
import { auditSportCoricoData } from '../app/lib/db/migrations/audit-sportcorico-data';
import { isSportCoricoDataPurgeEnabled } from '../app/lib/privacy/sportcorico-data';

async function main(): Promise<void> {
  const apply = isSportCoricoDataPurgeEnabled();
  if (!apply) {
    console.warn('[sportcorico:quarantine] Dry-run — aucune écriture. Pour appliquer : SPORTCORICO_DATA_PURGE=apply');
  } else {
    console.warn('[sportcorico:quarantine] Mode apply — quarantaine des enregistrements SportCorico.');
  }
  const db = await getDataSource();
  try {
    const report = await auditSportCoricoData(db, { apply });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error('[sportcorico:quarantine] Échec :', error);
  process.exit(1);
});
