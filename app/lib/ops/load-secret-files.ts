import { readFileSync } from 'node:fs';

/**
 * Secrets Docker (`NAME_FILE` → `NAME`) chargés au démarrage (issue #36).
 * Le contenu n'est pas journalisé. Un fichier illisible refuse le boot.
 */
export const SECRET_ENV_FILE_KEYS = [
  'DB_PASSWORD',
  'DB_USER',
  'DB_NAME',
  'MARIADB_ROOT_PASSWORD',
  'APP_ENCRYPTION_KEY',
  'BACKUP_ENCRYPTION_KEY',
  'CRON_SECRET',
  'VAPID_PRIVATE_KEY',
  'SMTP_PASSWORD',
  'BOOTSTRAP_SUPERADMIN_PASSWORD',
  'PLATFORM_ADMIN_PASSWORD',
  'DB_BACKUP_PASSWORD',
  'DB_RESTORE_PASSWORD',
] as const;

export function readSecretFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

export function loadSecretFilesFromEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  for (const name of SECRET_ENV_FILE_KEYS) {
    const filePath = env[`${name}_FILE`]?.trim();
    if (!filePath) continue;
    try {
      env[name] = readSecretFile(filePath);
    } catch {
      throw new Error(`${name}_FILE pointe vers un fichier illisible : secret refusé au démarrage.`);
    }
  }
}
