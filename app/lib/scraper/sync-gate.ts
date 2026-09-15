/**
 * Kill switch global de la synchronisation SportCorico (issue #4).
 *
 * Désactivé par défaut. La réactivation exige `SPORTCORICO_SYNC_ENABLED=true`
 * **et** une revue humaine d’une licence / autorisation écrite couvrant
 * précisément l’API et la réutilisation des données. Le flag club `scraperSync`
 * ne suffit jamais à lui seul.
 */

export const SPORTCORICO_SYNC_DISABLED_MESSAGE =
  'La synchronisation des calendriers externes est désactivée.';

export class SportCoricoSyncDisabledError extends Error {
  constructor() {
    super(SPORTCORICO_SYNC_DISABLED_MESSAGE);
    this.name = 'SportCoricoSyncDisabledError';
  }
}

export function isSportCoricoSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.SPORTCORICO_SYNC_ENABLED?.trim().toLowerCase() === 'true';
}

export function assertSportCoricoSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isSportCoricoSyncEnabled(env)) {
    throw new SportCoricoSyncDisabledError();
  }
}
