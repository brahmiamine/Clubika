import { createHash, randomBytes } from 'node:crypto';

export const PRIVACY_CATALOG_VERSION = 1 as const;

export const PRIVACY_REQUEST_TYPES = [
  'access',
  'portability',
  'rectification',
  'erasure',
  'restriction',
  'opposition',
] as const;
export type PrivacyRequestType = (typeof PRIVACY_REQUEST_TYPES)[number];

export const PRIVACY_REQUEST_STATUSES = [
  'received',
  'identity_pending',
  'in_review',
  'completed',
  'cancelled',
] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];

export const PRIVACY_DECISION_CODES = [
  'granted',
  'partial',
  'cancelled_by_subject',
  'identity_unverified',
  'delegated_erasure',
  'pending_human_legal_review',
] as const;
export type PrivacyDecisionCode = (typeof PRIVACY_DECISION_CODES)[number];

/** Texte unique : l’application ne calcule ni délai ni refus juridique. */
export const PRIVACY_NO_LEGAL_PROMISE =
  'Les délais, prolongations et refus prévus par le RGPD ne sont pas calculés ni décidés par cette application. Toute décision d’issue est humaine. Cette interface ne constitue pas une promesse de délai ou de résultat.';

export const PRIVACY_EXPORT_TTL_MS = 15 * 60 * 1000;

export function isPrivacyRequestType(value: unknown): value is PrivacyRequestType {
  return typeof value === 'string' && (PRIVACY_REQUEST_TYPES as readonly string[]).includes(value);
}

export function isPrivacyRequestStatus(value: unknown): value is PrivacyRequestStatus {
  return typeof value === 'string' && (PRIVACY_REQUEST_STATUSES as readonly string[]).includes(value);
}

export function isPrivacyDecisionCode(value: unknown): value is PrivacyDecisionCode {
  return typeof value === 'string' && (PRIVACY_DECISION_CODES as readonly string[]).includes(value);
}

export function newPrivacyToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashPrivacyToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex');
}

export function hashPrivacyEmail(clubId: string, email: string): string {
  return createHash('sha256')
    .update(`${clubId.trim().toLowerCase()}:${email.trim().toLowerCase()}`)
    .digest('hex');
}

export function normalizePrivacyEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isOutboundProcessingBlocked(user: {
  processingRestrictedAt?: Date | string | null;
  processingOpposedAt?: Date | string | null;
}): boolean {
  return Boolean(user.processingRestrictedAt || user.processingOpposedAt);
}

export function isPrivacyOperationalNotice(type: string): boolean {
  return type.startsWith('privacy-');
}
