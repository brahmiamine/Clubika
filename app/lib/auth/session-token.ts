import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_BYTES = 32;
const HASH_VERSION = 'v1';
const DEV_FALLBACK_PEPPER = 'clubika-dev-session-pepper';

function configuredPeppers(): string[] {
  const primary = process.env.SESSION_TOKEN_PEPPER?.trim()
    || process.env.APP_ENCRYPTION_KEY?.trim()
    || '';
  const previous = (process.env.SESSION_TOKEN_PREVIOUS_PEPPERS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (primary) return [primary, ...previous.filter((value) => value !== primary)];
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_TOKEN_PEPPER ou APP_ENCRYPTION_KEY est requis en production pour hasher les jetons de session.',
    );
  }
  return [DEV_FALLBACK_PEPPER, ...previous.filter((value) => value !== DEV_FALLBACK_PEPPER)];
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export function isPlausibleSessionToken(value: string | undefined | null): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function hashSessionToken(token: string, pepper = configuredPeppers()[0]!): string {
  const digest = createHmac('sha256', pepper).update(token).digest('hex');
  return `${HASH_VERSION}:${digest}`;
}

export function sessionTokenHashCandidates(token: string): string[] {
  return configuredPeppers().map((pepper) => hashSessionToken(token, pepper));
}

export function sessionTokenHashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
