import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { allSchemas } from './schemas';
import { runSchemaMigrations } from './migrations/runner';
import { schemaMigrations } from './migrations/schema-migrations';

declare global {
  var __clubikaDataSource: DataSource | undefined;
  var __clubikaDataSourceInitPromise: Promise<DataSource> | undefined;
  var __clubikaDbBootstrapped: boolean | undefined;
  var __clubikaDbBootstrapPromise: Promise<void> | undefined;
}

/**
 * Accès dynamique à `process.env` : Next.js inlinerait `process.env.DB_HOST`
 * (et les autres) au *build* Docker, où ces variables n'existent pas encore.
 * Le fallback `127.0.0.1` se retrouverait alors figé dans les routes API,
 * alors que `pnpm db:migrate` (tsx, hors bundle) parle bien à `mariadb`.
 */
function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function getPort(): number {
  const rawPort = readEnv('DB_PORT') ?? '3306';
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

/** Pool mysql2 : le driver `mysql` 2.x mélange les paquets en requêtes concurrentes. */
export const MARIADB_CONNECTOR_PACKAGE = 'mysql2' as const;

export function mariadbPoolExtra(): { connectionLimit: number; enableKeepAlive: boolean } {
  return { connectionLimit: 10, enableKeepAlive: true };
}

function createDataSource(): DataSource {
  return new DataSource({
    type: 'mariadb',
    host: readEnv('DB_HOST') ?? '127.0.0.1',
    port: getPort(),
    username: readEnv('DB_USER') ?? 'clubika_user',
    password: readEnv('DB_PASSWORD') ?? 'clubika_password',
    database: readEnv('DB_NAME') ?? 'clubika',
    entities: allSchemas,
    synchronize: false,
    logging: false,
    timezone: 'Z',
    charset: 'utf8mb4_unicode_ci',
    connectorPackage: MARIADB_CONNECTOR_PACKAGE,
    extra: mariadbPoolExtra(),
  });
}

async function discardDataSource(existing: DataSource | undefined): Promise<void> {
  globalThis.__clubikaDataSource = undefined;
  globalThis.__clubikaDbBootstrapped = false;
  globalThis.__clubikaDbBootstrapPromise = undefined;
  if (existing) {
    await existing.destroy().catch(() => undefined);
  }
}

export async function getDataSource(): Promise<DataSource> {
  if (globalThis.__clubikaDataSource?.isInitialized) {
    return globalThis.__clubikaDataSource;
  }

  if (!globalThis.__clubikaDataSourceInitPromise) {
    globalThis.__clubikaDataSourceInitPromise = (async () => {
      const dataSource = globalThis.__clubikaDataSource ?? createDataSource();
      globalThis.__clubikaDataSource = dataSource;
      try {
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
      } catch (error) {
        await discardDataSource(dataSource);
        throw error;
      }
    })().finally(() => {
      globalThis.__clubikaDataSourceInitPromise = undefined;
    });
  }

  return globalThis.__clubikaDataSourceInitPromise;
}
