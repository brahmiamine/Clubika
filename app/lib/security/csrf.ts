import { NextResponse, type NextRequest } from 'next/server';
import {
  isAllowedOriginUrl,
  requestHostOrigin,
  resolveBrowserOrigin,
} from '@/lib/security/request-origin';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Exemptions CSRF documentées (issue #35). Toute autre mutation est fail-closed.
 * - `/api/cron` : Bearer `CRON_SECRET`, pas d'origine navigateur.
 * - `/api/security/csp-report` : rapports navigateur sans session.
 */
export const CSRF_EXEMPT_PATHS = [
  '/api/cron',
  '/api/security/csp-report',
] as const;

export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method.toUpperCase());
}

export function isCsrfExemptPath(pathname: string): boolean {
  return CSRF_EXEMPT_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function csrfForbidden(): NextResponse {
  return NextResponse.json(
    { error: 'Origine non autorisée' },
    { status: 403, headers: { 'Cache-Control': 'private, no-store' } },
  );
}

/**
 * Fail-closed : mutation hors exemption ⇒ Origin/Referer allowlisté.
 * Cookie-authenticated ou non : une route non classée est bloquée (issue #35).
 */
export function enforceCsrf(request: NextRequest): NextResponse | null {
  if (!isMutatingMethod(request.method)) return null;
  const pathname = request.nextUrl.pathname;
  if (isCsrfExemptPath(pathname)) return null;

  const resolved = resolveBrowserOrigin({
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
  });
  if (resolved.explicitNull || resolved.missing || !resolved.origin) {
    return csrfForbidden();
  }

  const requestOrigin = requestHostOrigin({
    host: request.headers.get('host'),
    forwardedHost: request.headers.get('x-forwarded-host'),
    forwardedProto: request.headers.get('x-forwarded-proto'),
    fallbackOrigin: request.nextUrl.origin,
  });
  if (!isAllowedOriginUrl(resolved.origin, requestOrigin)) {
    return csrfForbidden();
  }
  return null;
}
