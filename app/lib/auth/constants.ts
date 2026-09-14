export const SESSION_COOKIE_NAME = resolveLoadedSessionCookieName();
export const PLATFORM_SESSION_COOKIE_NAME = resolveLoadedPlatformSessionCookieName();

function hostPrefixEnabled(): boolean {
  if (process.env.SESSION_COOKIE_HOST_PREFIX === 'true') return true;
  if (process.env.SESSION_COOKIE_HOST_PREFIX === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

function resolveLoadedSessionCookieName(): string {
  return hostPrefixEnabled() ? '__Host-session_token' : 'session_token';
}

function resolveLoadedPlatformSessionCookieName(): string {
  return hostPrefixEnabled() ? '__Host-platform_session_token' : 'platform_session_token';
}
