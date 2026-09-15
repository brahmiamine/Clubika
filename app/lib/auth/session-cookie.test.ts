import { describe, expect, it } from 'vitest';
import {
  resolvePlatformSessionCookieName,
  resolveSessionCookieName,
  sessionCookieSetOptions,
  sessionCookiesUseHostPrefix,
} from './session-cookie';

describe('session-cookie (issue #29)', () => {
  it('uses __Host- only in production unless overridden', () => {
    expect(sessionCookiesUseHostPrefix('test', undefined)).toBe(false);
    expect(sessionCookiesUseHostPrefix('production', undefined)).toBe(true);
    expect(sessionCookiesUseHostPrefix('production', 'false')).toBe(false);
    expect(resolveSessionCookieName('production')).toBe('__Host-session_token');
    expect(resolvePlatformSessionCookieName('test')).toBe('platform_session_token');
  });

  it('sets HttpOnly, Path=/, SameSite=Lax and never a Domain attribute', () => {
    const options = sessionCookieSetOptions(new Date('2030-01-01T00:00:00Z'));
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/');
    expect(options.sameSite).toBe('lax');
    expect(options).not.toHaveProperty('domain');
  });
});
