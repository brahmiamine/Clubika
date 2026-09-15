/**
 * Origine publique canonique (issue #32).
 *
 * Les liens sensibles (réinitialisation, invitation) ne doivent jamais être
 * fabriqués à partir de Host, X-Forwarded-Host ou de l'URL de la requête :
 * un attaquant peut forger ces en-têtes. Seule `APP_BASE_URL`, allowlistée,
 * sert de source. En production HTTPS est obligatoire et une configuration
 * manquante refuse le démarrage.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class CanonicalPublicOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalPublicOriginError';
  }
}

function parseOrigin(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isAllowedCanonicalUrl(url: URL, nodeEnv: string | undefined): boolean {
  if (url.username || url.password) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname) return false;
  if (nodeEnv === 'production') {
    if (url.protocol !== 'https:') return false;
    if (LOCAL_HOSTS.has(url.hostname.toLowerCase())) return false;
  }
  return true;
}

function configuredAllowlist(): string[] {
  const extra = (process.env.APP_PUBLIC_ORIGIN_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (extra.length > 0) return extra;
  const base = process.env.APP_BASE_URL?.trim();
  return base ? [base] : [];
}

function originOf(raw: string, nodeEnv: string | undefined): string | null {
  const url = parseOrigin(raw);
  if (!url || !isAllowedCanonicalUrl(url, nodeEnv)) return null;
  return url.origin;
}

/** Origine HTTPS (prod) / http (dev) issue uniquement de APP_BASE_URL. */
export function resolveCanonicalPublicOrigin(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string | null {
  const raw = process.env.APP_BASE_URL?.trim();
  if (!raw) return null;
  const origin = originOf(raw, nodeEnv);
  if (!origin) return null;

  const allowlist = configuredAllowlist()
    .map((candidate) => originOf(candidate, nodeEnv))
    .filter((value): value is string => Boolean(value));
  if (allowlist.length === 0) return null;
  if (!allowlist.includes(origin)) return null;
  return origin;
}

export function requireCanonicalPublicOrigin(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string {
  const origin = resolveCanonicalPublicOrigin(nodeEnv);
  if (origin) return origin;
  throw new CanonicalPublicOriginError(
    nodeEnv === 'production'
      ? 'APP_BASE_URL HTTPS canonique est obligatoire en production pour fabriquer un lien sensible.'
      : 'APP_BASE_URL est requis pour fabriquer un lien sensible (jamais dérivé de Host).',
  );
}

export function assertCanonicalPublicOriginForProduction(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): void {
  if (nodeEnv !== 'production') return;
  requireCanonicalPublicOrigin(nodeEnv);
}

export function sensitiveAbsoluteUrl(path: string, nodeEnv: string | undefined = process.env.NODE_ENV): string {
  const origin = requireCanonicalPublicOrigin(nodeEnv);
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${origin}${normalized}`;
}
