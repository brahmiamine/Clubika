import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { allSchemas } from './schemas';
import { runSchemaMigrations } from './migrations/runner';
import { schemaMigrations } from './migrations/schema-migrations';

declare global {
  var __clubikaDataSource: DataSource | undefined;
  var __clubikaDataSourceInitPromise: Promise<DataSource> | undefined;
}

function getPort(): number {
  const rawPort = process.env.DB_PORT ?? '3306';
  const parsedPort = Number.parseInt(rawPort, 10);
  return Number.isFinite(parsedPort) ? parsedPort : 3306;
}

/**
 * `synchronize` n'est jamais appelé en production (issue #283). Hors production,
 * il reste un opt-in explicite (`TYPEORM_SYNCHRONIZE=1`) pour un bac local, jamais
 * le chemin par défaut : le schéma attendu vient des migrations versionnées.
 */
export function shouldSynchronizeSchema(env: {
  NODE_ENV?: string;
  TYPEORM_SYNCHRONIZE?: string;
} = process.env): boolean {
  if ((env.NODE_ENV ?? '') === 'production') return false;
  return env.TYPEORM_SYNCHRONIZE === '1';
}

function createDataSource(): DataSource {
  return new DataSource({
    type: 'mariadb',
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: getPort(),
    username: process.env.DB_USER ?? 'clubika_user',
    password: process.env.DB_PASSWORD ?? 'clubika_password',
    database: process.env.DB_NAME ?? 'clubika',
    entities: allSchemas,
    synchronize: false,
    logging: false,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
  });
}

export async function getDataSource(): Promise<DataSource> {
  if (globalThis.__clubikaDataSource?.isInitialized) {
    return globalThis.__clubikaDataSource;
  }

  const dataSource = globalThis.__clubikaDataSource ?? createDataSource();
  globalThis.__clubikaDataSource = dataSource;

  if (globalThis.__clubikaDataSourceInitPromise) {
    await globalThis.__clubikaDataSourceInitPromise;
    return globalThis.__clubikaDataSource as DataSource;
  }

  globalThis.__clubikaDataSourceInitPromise = (async () => {
    if (!dataSource.isInitialized) {
      await dataSource.initialize();
    }
    // Migrations de schéma versionnées (issue #129) : exécutées avant toute
    // utilisation de la base, un échec bloque le démarrage applicatif.
    await runSchemaMigrations(dataSource, schemaMigrations);
    if (shouldSynchronizeSchema()) {
      await dataSource.synchronize();
    }
    return dataSource;
  })().finally(() => {
    globalThis.__clubikaDataSourceInitPromise = undefined;
  });

  await globalThis.__clubikaDataSourceInitPromise;
  return dataSource;
}
