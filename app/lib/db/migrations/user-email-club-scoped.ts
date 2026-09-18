import type { DataSource } from 'typeorm';

/**
 * Migration 0017 (issue #266) : l'unicité de `users.email` passe de globale à
 * `(clubId, email)`.
 *
 * Constat : une même personne (dirigeant bénévole, arbitre…) est fréquemment
 * engagée dans plusieurs clubs. L'ancienne contrainte unique globale sur `email`
 * l'empêchait d'avoir un compte — avec son propre mot de passe, son propre profil —
 * dans un second club de la même instance, alors que le README annonce
 * explicitement le multi-club. Décision retenue (voir README, section Multi-club) :
 * un compte reste rattaché à un seul club (pas de compte global partagé entre
 * clubs, pas de sélecteur de club à la connexion — la portée club de la requête
 * dérive de `user.clubId`, voir `lib/auth/club-context.ts`) ; seule la contrainte
 * d'unicité de l'email devient club-scoped, ce qui permet un compte indépendant par
 * club pour une même adresse.
 *
 * Sûreté de la migration : l'email était unique globalement avant cette migration,
 * donc deux lignes ne peuvent déjà pas partager le même `(clubId, email)` — la
 * conversion est sûre par construction. La vérification ci-dessous (`up`) le
 * reconfirme explicitement avant de toucher au schéma physique, plutôt que de se
 * fier seulement au raisonnement, au cas où une base aurait été restaurée/éditée
 * hors du contrôle applicatif.
 *
 * L'ancien index unique sur `email` seul porte un nom généré par TypeORM (dérivé
 * d'un hash table+colonnes), jamais fixé explicitement dans le code applicatif :
 * on le retrouve donc par introspection (`information_schema.STATISTICS`) plutôt
 * que de supposer son nom, comme le fait déjà la migration 0008 pour les clés
 * primaires — voir event-primary-keys.ts. Idempotente : une base déjà convertie
 * (ou neuve, créée directement par `synchronize` avec l'index composite) n'a plus
 * d'index mono-colonne à supprimer et l'index composite existe déjà.
 */

const TABLE = 'users';
const COMPOSITE_INDEX_NAME = 'uq_users_club_email';

export async function currentDatabase(db: DataSource): Promise<string> {
  const rows = await db.query('SELECT DATABASE() AS dbName') as Array<{ dbName?: string }>;
  const dbName = rows[0]?.dbName;
  if (!dbName) throw new Error('[migrations] 0017 : impossible de déterminer la base courante.');
  return String(dbName);
}

async function tableExists(db: DataSource, database: string, table: string): Promise<boolean> {
  const rows = await db.query(
    'SELECT TABLE_NAME AS tableName FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  ) as Array<{ tableName?: string }>;
  return rows.length > 0;
}

/** Noms des index uniques ne portant que sur `email` (hors PRIMARY) — l'ancienne contrainte globale. */
async function singleColumnUniqueIndexNames(db: DataSource, database: string, table: string, column: string): Promise<string[]> {
  const rows = await db.query(
    `SELECT INDEX_NAME AS indexName,
            COUNT(*) AS colCount,
            SUM(CASE WHEN COLUMN_NAME = ? THEN 1 ELSE 0 END) AS matchCount
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
     GROUP BY INDEX_NAME`,
    [column, database, table],
  ) as Array<{ indexName?: string; colCount?: number | string; matchCount?: number | string }>;
  return rows
    .filter((row) => Number(row.colCount) === 1 && Number(row.matchCount) === 1)
    .map((row) => String(row.indexName));
}

/** Refuse de continuer si deux lignes partagent déjà le même `(clubId, email)` — ne devrait jamais arriver, voir ci-dessus. */
async function assertNoClubEmailCollisions(db: DataSource, table: string): Promise<void> {
  const collisions = await db.query(
    `SELECT clubId, email, COUNT(*) AS rowCount
     FROM \`${table}\`
     GROUP BY clubId, email
     HAVING rowCount > 1
     LIMIT 5`,
  ) as Array<{ clubId?: string; email?: string; rowCount?: number | string }>;
  if (collisions.length > 0) {
    const pairs = collisions.map((row) => `(${String(row.clubId)}, ${String(row.email)})`).join(', ');
    throw new Error(
      `[migrations] 0017 : collision(s) (clubId, email) sur ${table} (${pairs}) — `
      + 'devrait être impossible tant que l\'ancien index unique global existait ; intervention manuelle requise.',
    );
  }
}

/**
 * Logique de conversion, paramétrée par table/index pour être exercée sur une
 * table de test isolée (voir user-email-club-scoped.test.ts) sans toucher à la
 * vraie table `users`. `scopeUserEmailUniquenessToClub` ci-dessous l'applique à
 * `users` pour la migration réelle.
 */
export async function scopeTableEmailUniquenessToClub(
  db: DataSource,
  table: string,
  compositeIndexName: string,
): Promise<void> {
  const database = await currentDatabase(db);
  if (!(await tableExists(db, database, table))) {
    // Base neuve : la table sera créée par `synchronize` avec l'index composite.
    return;
  }

  await assertNoClubEmailCollisions(db, table);

  const staleIndexNames = await singleColumnUniqueIndexNames(db, database, table, 'email');
  for (const indexName of staleIndexNames) {
    await db.query(`ALTER TABLE \`${table}\` DROP INDEX \`${indexName}\``);
    console.warn(`[migrations] 0017 : ${table} — index unique global « ${indexName} » sur email supprimé.`);
  }

  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS \`${compositeIndexName}\` ON \`${table}\` (clubId, email)`,
  );
}

export async function scopeUserEmailUniquenessToClub(db: DataSource): Promise<void> {
  await scopeTableEmailUniquenessToClub(db, TABLE, COMPOSITE_INDEX_NAME);
}
