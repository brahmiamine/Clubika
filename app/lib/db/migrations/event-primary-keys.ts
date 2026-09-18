import type { DataSource } from 'typeorm';

/**
 * Migration 0008 (issue #125) : conversion des clés primaires globales des tables
 * d'événements en clés composites tenant-scoped.
 *
 *   matches_officiels / matches_amicaux / entrainements / plateaux
 *     PRIMARY KEY (id)        → PRIMARY KEY (clubId, id)
 *   matches_extras
 *     PRIMARY KEY (matchId)   → PRIMARY KEY (clubId, matchId)
 *
 * La conversion est réalisée ici — et non laissée à `synchronize` — pour pouvoir
 * vérifier les collisions AVANT toute modification physique : deux clubs ne
 * doivent jamais partager la même clé métier. En pratique l'ancienne PK globale
 * garantissait déjà l'unicité, mais la vérification explicite protège contre
 * toute donnée hors norme (import manuel, base réparée…).
 *
 * Idempotente : la composition de la PK est relue à chaque passage ; une table
 * déjà convertie — ou absente (base neuve, créée ensuite par `synchronize`
 * directement avec la PK composite) — est ignorée.
 */

interface EventPrimaryKeyTarget {
  table: string;
  /** Colonne de clé métier : 'id' pour les événements, 'matchId' pour les extras. */
  businessKey: string;
}

const EVENT_PRIMARY_KEY_TARGETS: readonly EventPrimaryKeyTarget[] = [
  { table: 'matches_officiels', businessKey: 'id' },
  { table: 'matches_amicaux', businessKey: 'id' },
  { table: 'entrainements', businessKey: 'id' },
  { table: 'plateaux', businessKey: 'id' },
  { table: 'matches_extras', businessKey: 'matchId' },
];

async function currentDatabase(db: DataSource): Promise<string> {
  const rows = await db.query('SELECT DATABASE() AS dbName') as Array<{ dbName?: string }>;
  const dbName = rows[0]?.dbName;
  if (!dbName) throw new Error('[migrations] 0008 : impossible de déterminer la base courante.');
  return String(dbName);
}

async function tableExists(db: DataSource, database: string, table: string): Promise<boolean> {
  const rows = await db.query(
    'SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  ) as Array<{ tableName?: string }>;
  return rows.length > 0;
}

/** Colonnes de la clé primaire d'une table, dans l'ordre physique (SEQ_IN_INDEX). */
export async function primaryKeyColumns(db: DataSource, database: string, table: string): Promise<string[]> {
  const rows = await db.query(
    `SELECT COLUMN_NAME AS columnName FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
     ORDER BY SEQ_IN_INDEX`,
    [database, table],
  ) as Array<{ columnName?: string }>;
  return rows.map((row) => String(row.columnName));
}

/**
 * Convertit une table de la forme historique `PRIMARY KEY (businessKey)` vers
 * `PRIMARY KEY (clubId, businessKey)`, après vérification des collisions.
 * Ignore les tables absentes ou déjà converties ; refuse toute autre forme de PK.
 */
export async function convertTablePrimaryKeyToTenantScoped(
  db: DataSource,
  database: string,
  table: string,
  businessKey: string,
): Promise<void> {
  if (!(await tableExists(db, database, table))) {
    // Base neuve : la table sera créée par `synchronize` avec la PK composite.
    return;
  }

  const pk = await primaryKeyColumns(db, database, table);
  if (pk.length === 2 && pk[0] === 'clubId' && pk[1] === businessKey) {
    // Déjà convertie (rejoue idempotente).
    return;
  }
  if (!(pk.length === 1 && pk[0] === businessKey)) {
    throw new Error(
      `[migrations] 0008 : clé primaire inattendue (${pk.join(', ') || 'aucune'}) sur ${table} — `
      + 'seule la forme historique (clé métier seule) peut être convertie automatiquement, intervention manuelle requise.',
    );
  }

  // Vérification des collisions AVANT modification : une même clé métier
  // présente dans deux clubs rendrait la conversion impossible.
  const collisions = await db.query(
    `SELECT \`${businessKey}\` AS businessKeyValue, COUNT(*) AS rowCount
     FROM \`${table}\`
     GROUP BY \`${businessKey}\`
     HAVING rowCount > 1
     LIMIT 5`,
  ) as Array<{ businessKeyValue?: string; rowCount?: number | string }>;
  if (collisions.length > 0) {
    const keys = collisions.map((row) => `« ${String(row.businessKeyValue)} »`).join(', ');
    throw new Error(
      `[migrations] 0008 : collision(s) de clé métier sur ${table} (${keys}) — `
      + 'deux lignes partagent le même identifiant, résolvez les doublons avant de relancer la migration.',
    );
  }

  await db.query(
    `ALTER TABLE \`${table}\` DROP PRIMARY KEY, ADD PRIMARY KEY (clubId, \`${businessKey}\`)`,
  );
  console.warn(`[migrations] 0008 : ${table} — clé primaire convertie en (clubId, ${businessKey}).`);
}

export async function convertEventPrimaryKeysToTenantScoped(db: DataSource): Promise<void> {
  const database = await currentDatabase(db);
  for (const target of EVENT_PRIMARY_KEY_TARGETS) {
    await convertTablePrimaryKeyToTenantScoped(db, database, target.table, target.businessKey);
  }
}
