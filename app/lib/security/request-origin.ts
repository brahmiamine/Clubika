/**
 * Allowlist d'origines (issue #35) : CSRF cookie-authenticated et handshake WebSocket
 * partagent la même politique. Jamais d'origine « null ».
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export function parseOriginHeader(value: string | null | undefined): URL | null {
  const raw = value?.trim();
  if (!raw || raw.toLowerCase() === 'null') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export function originFromReferer(referer: string | null | undefined): URL | null {
  const raw = referer?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return parseOriginHeader(url.origin);
  } catch {
    return null;
  }
}

function extraAllowedOrigins(): string[] {
  const raw = process.env.CSRF_ALLOWED_ORIGINS ?? '';
  return raw.split(',').map((part) => part.trim()).filter(Boolean);
}

function canonicalAppOrigin(): string | null {
  const base = process.env.APP_BASE_URL?.trim();
  if (!base) return null;
  try {
    return new URL(base).origin;
  } catch {
    return null;
  }
}

export function requestHostOrigin(input: {
  host?: string | null;
  forwardedHost?: string | null;
  forwardedProto?: string | null;
  fallbackOrigin?: string | null;
}): string | null {
  const hostHeader = (input.forwardedHost || input.host || '').split(',')[0]?.trim();
  if (!hostHeader) return input.fallbackOrigin ?? null;
  const protoHeader = (input.forwardedProto || '').split(',')[0]?.trim().toLowerCase();
  const proto = protoHeader === 'https' || protoHeader === 'http'
    ? protoHeader
    : (input.fallbackOrigin?.startsWith('https:') ? 'https' : 'http');
  try {
    return new URL(`${proto}://${hostHeader}`).origin;
  } catch {
    return input.fallbackOrigin ?? null;
  }
}

/**
 * Production : uniquement APP_BASE_URL + CSRF_ALLOWED_ORIGINS.
 * Jamais d’ajout automatique de Host / X-Forwarded-Host (spoof → CSRF).
 * Hors production : localhost, puis same-origin avec l’hôte de la requête (LAN).
 */
export function isAllowedOriginUrl(origin: URL, requestOrigin: string | null): boolean {
  const allowed = new Set<string>();
  const appOrigin = canonicalAppOrigin();
  if (appOrigin) allowed.add(appOrigin);
  for (const extra of extraAllowedOrigins()) {
    const parsed = parseOriginHeader(extra);
    if (parsed) allowed.add(parsed.origin);
  }
  if (allowed.has(origin.origin)) return true;

  if (process.env.NODE_ENV !== 'production') {
    if (LOCAL_HOSTS.has(origin.hostname)) return true;
    if (requestOrigin && origin.origin === requestOrigin) return true;
  }

  return false;
}

export function resolveBrowserOrigin(headers: {
  origin?: string | null;
  referer?: string | null;
}): { origin: URL | null; missing: boolean; explicitNull: boolean } {
  const rawOrigin = headers.origin?.trim();
  if (rawOrigin?.toLowerCase() === 'null') {
    return { origin: null, missing: false, explicitNull: true };
  }
  if (rawOrigin) {
    return { origin: parseOriginHeader(rawOrigin), missing: false, explicitNull: false };
  }
  const fromReferer = originFromReferer(headers.referer);
  if (fromReferer) {
    return { origin: fromReferer, missing: false, explicitNull: false };
  }
  return { origin: null, missing: true, explicitNull: false };
}
