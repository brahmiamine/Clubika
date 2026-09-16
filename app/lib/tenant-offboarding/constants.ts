import { createHash } from 'node:crypto';

export const PRIVACY_NO_LEGAL_PROMISE =
  'Les délais, conservations et refus affichés ici sont des paramètres produit. '
  + 'Ils ne constituent pas un avis juridique ni une obligation légale calculée par l’application.';

export const OFFBOARDING_STATUSES = ['none', 'frozen', 'purged'] as const;
export type OffboardingStatus = (typeof OFFBOARDING_STATUSES)[number];

export const LEGAL_HOLD_MOTIVES = ['litige', 'controle_autorite', 'instruction_humaine'] as const;
export type LegalHoldMotive = (typeof LEGAL_HOLD_MOTIVES)[number];

export const LEGAL_HOLD_SCOPES = ['full_tenant'] as const;
export type LegalHoldScope = (typeof LEGAL_HOLD_SCOPES)[number];

export const PROCESSOR_IDS = ['smtp', 'web_push', 'whatsapp', 'scraper'] as const;
export type ProcessorId = (typeof PROCESSOR_IDS)[number];

export const PROCESSOR_STATUSES = ['pending', 'acknowledged', 'failed', 'not_applicable'] as const;
export type ProcessorStatus = (typeof PROCESSOR_STATUSES)[number];

export const TOMBSTONE_CLUB_NAME = 'club-supprimé';

export const EXPORT_TTL_MS = 15 * 60 * 1000;
export const MAX_RETENTION_DAYS = 3650;

export function hashClubId(clubId: string): string {
  return createHash('sha256').update(`clubika-tenant:${clubId}`).digest('hex');
}

export function offboardingBatchSize(): number {
  const raw = Number.parseInt(process.env.OFFBOARDING_BATCH_SIZE ?? '100', 10);
  if (!Number.isFinite(raw) || raw < 1) return 100;
  return Math.min(raw, 500);
}

export function cronMayPurge(): boolean {
  return process.env.OFFBOARDING_CRON_PURGE === '1';
}
