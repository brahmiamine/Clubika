import { createHash } from 'node:crypto';

export function maskTelephone(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 2) return '••';
  return `•• •• •• •• ${digits.slice(-2)}`;
}

export function hashContactLookup(clubId: string, value: string): string {
  return createHash('sha256').update(`non-account:${clubId}:${value.trim().toLowerCase()}`).digest('hex');
}

export function isKnown<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}
