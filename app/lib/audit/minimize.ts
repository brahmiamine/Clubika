import {
  AUDIT_CATALOG_VERSION,
  isAllowedAuditKey,
  isDeniedAuditKey,
} from './catalog';

const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_LIKE = /(?:\+|00)?\d[\d .\-()]{7,}\d/;
const URL_LIKE = /https?:\/\/|wss?:\/\/|\/[a-z0-9._-]+\?[^\s]*[Ss]ignature=/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+-Z]+)?$/;
const FR_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const CLOCK_TIME = /^\d{2}:\d{2}(?::\d{2})?$/;
const FIELD_PATH = /^[a-zA-Z][a-zA-Z0-9_.]*$/;
const MIME_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const TECHNICAL_TOKEN = /^[a-z0-9]+(?:[_.:-][a-z0-9]+)*$/i;

function isEmptyObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0;
}

function isTechnicalString(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (ISO_DATE.test(trimmed) || FR_DATE.test(trimmed) || CLOCK_TIME.test(trimmed)) {
    return true;
  }
  if (EMAIL_LIKE.test(trimmed) || PHONE_LIKE.test(trimmed) || URL_LIKE.test(trimmed)) {
    return false;
  }
  if (/\s/.test(trimmed)) return false;

  const normalized = key.replace(/[_-]/g, '').toLowerCase();
  if (normalized === 'changedfields' && FIELD_PATH.test(trimmed) && trimmed.length <= 80) {
    return true;
  }
  if (normalized === 'mimetype' && MIME_TYPE.test(trimmed)) return true;
  if (TECHNICAL_TOKEN.test(trimmed) && trimmed.length <= 96) return true;
  return false;
}

function minimizePrimitive(key: string, value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === 'string') {
    return isTechnicalString(key, value) ? value.trim() : undefined;
  }
  return undefined;
}

function minimizeArray(key: string, value: unknown[]): unknown[] | undefined {
  const next = value
    .map((item) => {
      if (item == null || typeof item !== 'object') {
        return minimizePrimitive(key, item);
      }
      return minimizeUnknown(key, item);
    })
    .filter((item) => item !== undefined && item !== null && !isEmptyObject(item));
  return next.length > 0 || value.length === 0 ? next : undefined;
}

function minimizeObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isAllowedAuditKey(key) || isDeniedAuditKey(key)) continue;
    const minimized = minimizeUnknown(key, nested);
    if (minimized === undefined) continue;
    next[key] = minimized;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function minimizeUnknown(key: string, value: unknown): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) return minimizeArray(key, value);
  if (typeof value === 'object') {
    return minimizeObject(value as Record<string, unknown>);
  }
  return minimizePrimitive(key, value);
}

/**
 * Réduit un payload d'audit au catalogue v1. Un objet vide devient `null`.
 * Les tableaux à la racine (non représentables dans le schéma Record) sont refusés.
 */
export function minimizeAuditPayload(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const minimized = minimizeObject(value as Record<string, unknown>);
  return minimized ?? null;
}

export function auditPayloadsEqual(
  left: Record<string, unknown> | null,
  right: Record<string, unknown> | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Détecte une valeur sentinelle (e-mail, nom, texte…) dans un payload déjà sérialisé. */
export function auditBlobContainsNeedle(value: unknown, needles: readonly string[]): boolean {
  if (needles.length === 0) return false;
  const blob = JSON.stringify(value ?? null).toLowerCase();
  return needles.some((needle) => blob.includes(needle.toLowerCase()));
}

export { AUDIT_CATALOG_VERSION };
