import { PLATFORM_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME } from './constants';

export { PLATFORM_SESSION_COOKIE_NAME, SESSION_COOKIE_NAME };

/**
 * `__Host-` exige Secure, Path=/ et l'absence de Domain. Compatible avec HTTPS
 * en production ; désactivé en HTTP local / tests (issue #29).
 */
export function sessionCookiesUseHostPrefix(
  nodeEnv = process.env.NODE_ENV,
  override = process.env.SESSION_COOKIE_HOST_PREFIX,
): boolean {
  if (override === 'true') return true;
  if (override === 'false') return false;
  return nodeEnv === 'production';
}

export function resolveSessionCookieName(
  nodeEnv = process.env.NODE_ENV,
  override = process.env.SESSION_COOKIE_HOST_PREFIX,
): string {
  return sessionCookiesUseHostPrefix(nodeEnv, override) ? '__Host-session_token' : 'session_token';
}

export function resolvePlatformSessionCookieName(
  nodeEnv = process.env.NODE_ENV,
  override = process.env.SESSION_COOKIE_HOST_PREFIX,
): string {
  return sessionCookiesUseHostPrefix(nodeEnv, override)
    ? '__Host-platform_session_token'
    : 'platform_session_token';
}

function cookieSecure(): boolean {
  return sessionCookiesUseHostPrefix() || process.env.NODE_ENV === 'production';
}

export function sessionCookieSetOptions(expiresAt: Date) {
  return {
    httpOnly: true as const,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    expires: expiresAt,
    path: '/' as const,
  };
}

export function sessionCookieClearOptions() {
  return {
    httpOnly: true as const,
    secure: cookieSecure(),
    sameSite: 'lax' as const,
    path: '/' as const,
    maxAge: 0,
  };
}
