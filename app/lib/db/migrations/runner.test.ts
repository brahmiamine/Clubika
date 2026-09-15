import { afterAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { getDataSource } from '../data-source';
import { isDbAvailable } from '../test-utils';
import {
  computeMigrationChecksum,
  computeStatementsChecksum,
  readMigrationLogicFile,
  resolveMigrationsDir,
  runSchemaMigrations,
  validateMigrationRegistry,
  type SchemaMigration,
} from './runner';
import { schemaMigrations } from './schema-migrations';
import { TYPEORM_ENTITY_TABLE_NAMES } from './typeorm-entity-tables';

const dbAvailable = await isDbAvailable();

function fakeMigration(version: string, name: string, statements: string[] = []): SchemaMigration {
  return { version, name, statements };
}

describe('resolveMigrationsDir', () => {
  it('trouve les fichiers d\'empreinte (tsx ou repli cwd)', () => {
    expect(resolveMigrationsDir()).toMatch(/migrations$/);
    expect(readMigrationLogicFile('typeorm-entity-tables.ts')).toContain('TYPEORM_ENTITY_TABLE_STATEMENTS');
  });
});

describe('validateMigrationRegistry', () => {
  it('accepte un registre ordonné', () => {
    expect(() => validateMigrationRegistry([
      fakeMigration('0001', 'a', ['SELECT 1']),
      fakeMigration('0002', 'b', ['SELECT 1']),
    ])).not.toThrow();
  });

  it('rejette une version mal formatée', () => {
    expect(() => validateMigrationRegistry([fakeMigration('1', 'a', ['SELECT 1'])])).toThrow(/format attendu/);
  });

  it('rejette un doublon de version', () => {
    expect(() => validateMigrationRegistry([
      fakeMigration('0001', 'a', ['SELECT 1']),
      fakeMigration('0001', 'b', ['SELECT 1']),
    ])).toThrow(/en double/);
  });

  it('rejette un registre désordonné', () => {
    expect(() => validateMigrationRegistry([
      fakeMigration('0002', 'a', ['SELECT 1']),
      fakeMigration('0001', 'b', ['SELECT 1']),
    ])).toThrow(/désordonné/);
  });

  it('rejette une migration vide', () => {
    expect(() => validateMigrationRegistry([fakeMigration('0001', 'a')])).toThrow(/est vide/);
  });

  it('rejette un up() sans logique d\'empreinte', () => {
    expect(() => validateMigrationRegistry([{
      version: '0001',
      name: 'a',
      statements: ['SELECT 1'],
      up: async () => undefined,
    }])).toThrow(/sans logique d'empreinte/);
  });

  it('le registre applicatif fournit une logique d\'empreinte pour chaque up()', () => {
    expect(() => validateMigrationRegistry(schemaMigrations)).not.toThrow();
    for (const migration of schemaMigrations) {
      if (migration.up) expect(migration.logic?.length).toBeGreaterThan(0);
    }
  });
});

describe('computeMigrationChecksum', () => {
  it('est stable pour un contenu identique', () => {
    const a = fakeMigration('0001', 'a', ['CREATE TABLE x (id INT)']);
    const b = fakeMigration('0001', 'a', ['CREATE TABLE x (id INT)']);
    expect(computeMigrationChecksum(a)).toBe(computeMigrationChecksum(b));
  });

  it('change dès qu\'une instruction change', () => {
    const a = fakeMigration('0001', 'a', ['CREATE TABLE x (id INT)']);
    const b = fakeMigration('0001', 'a', ['CREATE TABLE x (id BIGINT)']);
    expect(computeMigrationChecksum(a)).not.toBe(computeMigrationChecksum(b));
  });

  it('change dès que la logique up change, à SQL égal (issue #283)', () => {
    const statements = ['SELECT 1'];
    const a: SchemaMigration = { version: '0001', name: 'a', statements, up: async () => undefined, logic: 'insert-one' };
    const b: SchemaMigration = { version: '0001', name: 'a', statements, up: async () => undefined, logic: 'insert-two' };
    expect(computeMigrationChecksum(a)).not.toBe(computeMigrationChecksum(b));
    expect(computeStatementsChecksum(a)).toBe(computeStatementsChecksum(b));
  });
});

describe.skipIf(!dbAvailable)('runSchemaMigrations (intégration MariaDB)', () => {
  const scratchTable = 'schema_migrations_runner_test';
  const scratchData = 'migration_runner_scratch';
  const lockBase = 'migration_runner_test';

  async function cleanup(db: DataSource): Promise<void> {
    await db.query(`DROP TABLE IF EXISTS ${scratchTable}`);
    await db.query(`DROP TABLE IF EXISTS ${scratchData}`);
  }

  afterAll(async () => {
    const db = await getDataSource();
    await cleanup(db);
  });

  it('applique les migrations sur une base vierge puis ne les rejoue pas', async () => {
    const db = await getDataSource();
    await cleanup(db);

    const migrations: SchemaMigration[] = [
      fakeMigration('0001', 'scratch_table', [
        `CREATE TABLE IF NOT EXISTS ${scratchData} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`,
      ]),
      { ...fakeMigration('0002', 'scratch_row'), up: async (d) => { await d.query(`INSERT IGNORE INTO ${scratchData} (id) VALUES (1)`); }, logic: 'insert-scratch-row' },
    ];

    const firstRun = await runSchemaMigrations(db, migrations, { tableName: scratchTable, lockName: `${lockBase}_fresh` });
    expect(firstRun).toEqual(['0001', '0002']);

    const rows = await db.query(`SELECT version, name, checksum FROM ${scratchTable} ORDER BY version`) as Array<Record<string, unknown>>;
    expect(rows.map((row) => String(row.version))).toEqual(['0001', '0002']);
    expect(String(rows[0]!.checksum)).toMatch(/^[0-9a-f]{64}$/);
    const data = await db.query(`SELECT id FROM ${scratchData}`);
    expect(data).toHaveLength(1);

    // Deuxième exécution : aucune réexécution (idempotence du runner).
    const secondRun = await runSchemaMigrations(db, migrations, { tableName: scratchTable, lockName: `${lockBase}_fresh` });
    expect(secondRun).toEqual([]);
  });

  it('bloque si une migration appliquée a été modifiée (immuabilité)', async () => {
    const db = await getDataSource();
    await cleanup(db);

    await runSchemaMigrations(db, [fakeMigration('0001', 'scratch_table', [
      `CREATE TABLE IF NOT EXISTS ${scratchData} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`,
    ])], { tableName: scratchTable, lockName: `${lockBase}_tamper` });

    await db.query(`UPDATE ${scratchTable} SET checksum = ? WHERE version = ?`, ['0'.repeat(64), '0001']);

    await expect(runSchemaMigrations(db, [fakeMigration('0001', 'scratch_table', [
      `CREATE TABLE IF NOT EXISTS ${scratchData} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`,
    ])], { tableName: scratchTable, lockName: `${lockBase}_tamper` })).rejects.toThrow(/immuables/);
  });

  it('bloque si une migration appliquée a disparu du registre (dérive)', async () => {
    const db = await getDataSource();
    await cleanup(db);

    await runSchemaMigrations(db, [
      fakeMigration('0001', 'scratch_a', [`CREATE TABLE IF NOT EXISTS ${scratchData} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`]),
      fakeMigration('0002', 'scratch_b', ['SELECT 1']),
    ], { tableName: scratchTable, lockName: `${lockBase}_drift` });

    await expect(runSchemaMigrations(db, [
      fakeMigration('0001', 'scratch_a', [`CREATE TABLE IF NOT EXISTS ${scratchData} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`]),
    ], { tableName: scratchTable, lockName: `${lockBase}_drift` })).rejects.toThrow(/absente du registre/);
  });

  it('bloque si up() d\'une migration appliquée a changé (issue #283)', async () => {
    const db = await getDataSource();
    await cleanup(db);

    const original: SchemaMigration = {
      version: '0001',
      name: 'scratch_up',
      statements: [`CREATE TABLE IF NOT EXISTS ${scratchData} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`],
      up: async () => undefined,
      logic: 'noop-v1',
    };
    await runSchemaMigrations(db, [original], { tableName: scratchTable, lockName: `${lockBase}_up` });

    const tampered: SchemaMigration = {
      ...original,
      logic: 'noop-v2',
      up: async (target) => { await target.query('SELECT 1'); },
    };
    await expect(runSchemaMigrations(db, [tampered], {
      tableName: scratchTable,
      lockName: `${lockBase}_up`,
    })).rejects.toThrow(/immuables/);
  });

  it('réécrit l\'empreinte statements-only vers la couverture de up() (issue #283)', async () => {
    const db = await getDataSource();
    await cleanup(db);

    const migration: SchemaMigration = {
      version: '0001',
      name: 'scratch_checksum_upgrade',
      statements: [`CREATE TABLE IF NOT EXISTS ${scratchData} (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB`],
      up: async () => undefined,
      logic: 'upgrade-logic',
    };
    await runSchemaMigrations(db, [migration], { tableName: scratchTable, lockName: `${lockBase}_upgrade` });
    await db.query(`UPDATE ${scratchTable} SET checksum = ? WHERE version = ?`, [
      computeStatementsChecksum(migration),
      '0001',
    ]);

    const applied = await runSchemaMigrations(db, [migration], {
      tableName: scratchTable,
      lockName: `${lockBase}_upgrade`,
    });
    expect(applied).toEqual([]);
    const rows = await db.query(
      `SELECT checksum FROM ${scratchTable} WHERE version = ?`,
      ['0001'],
    ) as Array<{ checksum: string }>;
    expect(rows[0]?.checksum).toBe(computeMigrationChecksum(migration));
  });

  it('le registre applicatif réel est valide et intégralement appliqué au démarrage', async () => {
    const db = await getDataSource();

    // getDataSource() a déjà exécuté le runner : une relance ne doit rien rejouer.
    const reapplied = await runSchemaMigrations(db, schemaMigrations);
    expect(reapplied).toEqual([]);

    const rows = await db.query('SELECT version FROM schema_migrations ORDER BY version') as Array<{ version: string }>;
    expect(rows.map((row) => String(row.version))).toEqual(schemaMigrations.map((migration) => migration.version));

    const tables = await db.query(
      `SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?)`,
      [[
        'planning_records',
        'planning_attachments',
        'planning_event_state',
        'push_subscriptions',
        'planning_notification_outbox',
        'chat_attachments',
        'scraper_sync_runs',
        'planning_assignment_state',
        'tenant_offboarding_exports',
        'tenant_processor_instructions',
        'tenant_offboarding_events',
        'tenant_deletion_certificates',
        ...TYPEORM_ENTITY_TABLE_NAMES,
      ]],
    ) as Array<{ name: string }>;
    expect(tables.map((row) => String(row.name)).sort()).toEqual([
      'chat_attachments',
      'planning_assignment_state',
      'planning_attachments',
      'planning_event_state',
      'planning_notification_outbox',
      'planning_records',
      'push_subscriptions',
      'scraper_sync_runs',
      'tenant_deletion_certificates',
      'tenant_offboarding_events',
      'tenant_offboarding_exports',
      'tenant_processor_instructions',
      ...TYPEORM_ENTITY_TABLE_NAMES,
    ].sort());
  });
});
