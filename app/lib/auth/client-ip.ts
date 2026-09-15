import { isIP } from 'node:net';
import type { NextRequest } from 'next/server';

type HeaderValue = string | string[] | null | undefined;

function trustedProxyCount(): number {
  const raw = Number(process.env.TRUSTED_PROXY_COUNT);
  return Number.isInteger(raw) && raw >= 0 ? raw : 1;
}

export function trustProxyHeadersEnabled(
  value = process.env.TRUST_PROXY_HEADERS,
): boolean {
  return value === 'true';
}

function flattenHeader(value: HeaderValue): string[] {
  if (value == null) return [];
  const parts = Array.isArray(value) ? value : [value];
  return parts
    .flatMap((part) => part.split(','))
    .map((hop) => hop.trim())
    .filter(Boolean);
}

function pickClientFromForwarded(hops: string[], trustedCount: number): string | null {
  if (hops.length === 0 || trustedCount <= 0) return null;
  const clientIndex = hops.length - trustedCount;
  const candidate = hops[clientIndex >= 0 ? clientIndex : 0];
  return candidate && isIP(candidate) ? candidate : null;
}

/**
 * IP cliente à partir d'en-têtes forwarded uniquement si un proxy est
 * explicitement déclaré (`TRUST_PROXY_HEADERS=true`). Sinon les en-têtes
 * sont ignorés — un client peut toujours préfixer `X-Forwarded-For` (issue #29).
 */
export function clientIpFromForwardedHeaders(
  getHeader: (name: string) => HeaderValue,
  trust = trustProxyHeadersEnabled(),
  trustedCount = trustedProxyCount(),
): string | null {
  if (!trust) return null;
  const fromXff = pickClientFromForwarded(flattenHeader(getHeader('x-forwarded-for')), trustedCount);
  if (fromXff) return fromXff;
  const realIp = flattenHeader(getHeader('x-real-ip'))[0];
  if (realIp && isIP(realIp)) return realIp;
  return null;
}

/**
 * Adresse IP cliente pour la limitation de débit à la connexion.
 * Ne doit jamais lever : retombe sur 'unknown' plutôt que de bloquer une requête
 * légitime faute d'en-tête exploitable.
 */
export function getClientIp(request: NextRequest): string {
  return clientIpFromForwardedHeaders((name) => request.headers.get(name)) ?? 'unknown';
}
