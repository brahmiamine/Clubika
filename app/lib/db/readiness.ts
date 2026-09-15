import { createConnection } from 'mysql2/promise';
import { loadSecretFilesFromEnv } from '../ops/load-secret-files';

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Ping SQL isolé : pas de DataSource TypeORM, pas de migrations, pas de bootstrap
 * tenant (issue #36). Un échec ne doit jamais remonter le message MariaDB au client.
 */
export async function pingDatabaseForReadiness(
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  loadSecretFilesFromEnv(env);
  const portRaw = readEnv(env, 'DB_PORT') ?? '3306';
  const port = Number.parseInt(portRaw, 10);
  const connection = await createConnection({
    host: readEnv(env, 'DB_HOST') ?? '127.0.0.1',
    port: Number.isFinite(port) ? port : 3306,
    user: readEnv(env, 'DB_USER') ?? 'clubika_user',
    password: readEnv(env, 'DB_PASSWORD') ?? 'clubika_password',
    database: readEnv(env, 'DB_NAME') ?? 'clubika',
    connectTimeout: 3000,
  });
  try {
    await connection.query('SELECT 1');
    const [rows] = await connection.query('SELECT 1 AS ok FROM schema_migrations LIMIT 1');
    return Array.isArray(rows) && rows.length > 0;
  } finally {
    await connection.end();
  }
}
