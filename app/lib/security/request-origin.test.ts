import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAllowedOriginUrl,
  parseOriginHeader,
  requestHostOrigin,
  resolveBrowserOrigin,
} from './request-origin';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('request origin allowlist (issue #35)', () => {
  it('refuse Origin null et les schémas non http(s)', () => {
    expect(parseOriginHeader('null')).toBeNull();
    expect(parseOriginHeader('file://host')).toBeNull();
    expect(resolveBrowserOrigin({ origin: 'null' })).toMatchObject({ explicitNull: true, origin: null });
  });

  it('replie sur Referer quand Origin est absent', () => {
    const resolved = resolveBrowserOrigin({
      origin: null,
      referer: 'https://clubika.com/club/planning?x=1',
    });
    expect(resolved.origin?.origin).toBe('https://clubika.com');
    expect(resolved.missing).toBe(false);
  });

  it('autorise l’origine canonique et refuse une origine forgée', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_BASE_URL', 'https://clubika.com');
    const allowed = parseOriginHeader('https://clubika.com')!;
    const forged = parseOriginHeader('https://evil.example')!;
    expect(isAllowedOriginUrl(allowed, 'https://clubika.com')).toBe(true);
    expect(isAllowedOriginUrl(forged, 'https://clubika.com')).toBe(false);
  });

  it('ne fait pas confiance à Host / X-Forwarded-Host en production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_BASE_URL', 'https://clubika.com');
    const forged = parseOriginHeader('https://evil.example')!;
    expect(isAllowedOriginUrl(forged, 'https://evil.example')).toBe(false);
  });

  it('autorise une origine listée dans CSRF_ALLOWED_ORIGINS', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_BASE_URL', 'https://clubika.com');
    vi.stubEnv('CSRF_ALLOWED_ORIGINS', 'https://preview.clubika.test');
    const preview = parseOriginHeader('https://preview.clubika.test')!;
    expect(isAllowedOriginUrl(preview, 'https://clubika.com')).toBe(true);
  });

  it('autorise localhost hors production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('APP_BASE_URL', '');
    const local = parseOriginHeader('http://127.0.0.1:3000')!;
    expect(isAllowedOriginUrl(local, 'http://127.0.0.1:3000')).toBe(true);
  });

  it('reconstruit l’origine du reverse-proxy', () => {
    expect(requestHostOrigin({
      host: 'internal:3000',
      forwardedHost: 'clubika.com',
      forwardedProto: 'https',
    })).toBe('https://clubika.com');
  });
});
