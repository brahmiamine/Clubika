/**
 * Politique de rétention (issue #9).
 *
 * Les durées sont des **décisions produit initiales**, configurables, à valider
 * par un humain (#12 / #40). Elles ne sont pas imposées par le RGPD/CNIL.
 * Pas d’archivage intermédiaire des données personnelles : aucune base légale
 * n’a été fournie pour conserver une seconde copie.
 */

export const RETENTION_ENV_PREFIX = 'RETENTION_';

export type RetentionCategoryId =
  | 'chat'
  | 'planningAttachments'
  | 'reports'
  | 'audit'
  | 'sessions'
  | 'notifications'
  | 'invitations'
  | 'passwordReset'
  | 'push'
  | 'scraperRuns'
  | 'outbox'
  | 'rateLimits'
  | 'publicShares';

export interface RetentionCategory {
  id: RetentionCategoryId;
  envKey: string;
  defaultDays: number;
  /** Finalité opérationnelle (pas une base légale). */
  purpose: string;
  /** Accès typique. */
  access: string;
  scope: 'club' | 'global';
}

export const RETENTION_CATEGORIES: readonly RetentionCategory[] = [
  {
    id: 'chat',
    envKey: 'RETENTION_CHAT_DAYS',
    defaultDays: 365,
    purpose: 'Messages et pièces jointes de conversation',
    access: 'participants du salon, admin club',
    scope: 'club',
  },
  {
    id: 'planningAttachments',
    envKey: 'RETENTION_PLANNING_ATTACHMENTS_DAYS',
    defaultDays: 365,
    purpose: 'Documents joints aux événements',
    access: 'espace événement',
    scope: 'club',
  },
  {
    id: 'reports',
    envKey: 'RETENTION_REPORTS_DAYS',
    defaultDays: 365,
    purpose: 'Rapports post-événement',
    access: 'espace événement',
    scope: 'club',
  },
  {
    id: 'audit',
    envKey: 'RETENTION_AUDIT_DAYS',
    defaultDays: 365,
    purpose: 'Journal d’actions (preuves techniques)',
    access: 'administrateurs club',
    scope: 'club',
  },
  {
    id: 'sessions',
    envKey: 'RETENTION_SESSIONS_DAYS',
    defaultDays: 30,
    purpose: 'Sessions expirées ou révoquées (club + plateforme)',
    access: 'système d’authentification',
    scope: 'club',
  },
  {
    id: 'notifications',
    envKey: 'RETENTION_NOTIFICATIONS_DAYS',
    defaultDays: 180,
    purpose: 'Notifications in-app',
    access: 'destinataire',
    scope: 'club',
  },
  {
    id: 'invitations',
    envKey: 'RETENTION_INVITATIONS_DAYS',
    defaultDays: 90,
    purpose: 'Invitations utilisées ou expirées',
    access: 'admin club',
    scope: 'club',
  },
  {
    id: 'passwordReset',
    envKey: 'RETENTION_PASSWORD_RESET_DAYS',
    defaultDays: 7,
    purpose: 'Jetons de réinitialisation utilisés ou expirés',
    access: 'système d’authentification',
    scope: 'club',
  },
  {
    id: 'push',
    envKey: 'RETENTION_PUSH_DAYS',
    defaultDays: 365,
    purpose: 'Abonnements Web Push inactifs',
    access: 'système de notification',
    scope: 'club',
  },
  {
    id: 'scraperRuns',
    envKey: 'RETENTION_SCRAPER_RUNS_DAYS',
    defaultDays: 90,
    purpose: 'Journaux d’exécution du scrape (pas les événements importés)',
    access: 'admin club / plateforme',
    scope: 'club',
  },
  {
    id: 'outbox',
    envKey: 'RETENTION_OUTBOX_DAYS',
    defaultDays: 30,
    purpose: 'File d’attente des notifications (titre/message)',
    access: 'système de notification',
    scope: 'club',
  },
  {
    id: 'rateLimits',
    envKey: 'RETENTION_RATE_LIMITS_DAYS',
    defaultDays: 14,
    purpose: 'Compteurs anti-abus (empreintes, pas d’IP en clair)',
    access: 'système',
    scope: 'global',
  },
  {
    id: 'publicShares',
    envKey: 'RETENTION_PUBLIC_SHARES_DAYS',
    defaultDays: 90,
    purpose: 'Liens de partage public expirés ou anciens',
    access: 'jeton, puis admin',
    scope: 'club',
  },
] as const;

export const DEFAULT_RETENTION_BATCH_SIZE = 200;

export function parsePositiveInt(raw: string | undefined, fallback: number, max = 3650): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

export function retentionDaysFor(category: RetentionCategory, env: Record<string, string | undefined> = process.env): number {
  return parsePositiveInt(env[category.envKey], category.defaultDays);
}

export function retentionCutoff(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export function retentionBatchSize(env: NodeJS.ProcessEnv = process.env): number {
  return parsePositiveInt(env.RETENTION_BATCH_SIZE, DEFAULT_RETENTION_BATCH_SIZE, 1000);
}

export function resolvedRetentionPolicy(env: Record<string, string | undefined> = process.env): Array<RetentionCategory & { days: number }> {
  return RETENTION_CATEGORIES.map((category) => ({
    ...category,
    days: retentionDaysFor(category, env),
  }));
}
