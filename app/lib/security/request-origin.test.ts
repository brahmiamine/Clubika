import { afterEach, describe, expect, it } from 'vitest';
import {
  isAllowedOriginUrl,
  parseOriginHeader,
  requestHostOrigin,
  resolveBrowserOrigin,
} from './request-origin';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  APP_BASE_URL: process.env.APP_BASE_URL,
  CSRF_ALLOWED_ORIGINS: process.env.CSRF_ALLOWED_ORIGINS,
};

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;
  if (ORIGINAL_ENV.APP_BASE_URL === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = ORIGINAL_ENV.APP_BASE_URL;
  if (ORIGINAL_ENV.CSRF_ALLOWED_ORIGINS === undefined) delete process.env.CSRF_ALLOWED_ORIGINS;
  else process.env.CSRF_ALLOWED_ORIGINS = ORIGINAL_ENV.CSRF_ALLOWED_ORIGINS;
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
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = 'https://clubika.com';
    const allowed = parseOriginHeader('https://clubika.com')!;
    const forged = parseOriginHeader('https://evil.example')!;
    expect(isAllowedOriginUrl(allowed, 'https://clubika.com')).toBe(true);
    expect(isAllowedOriginUrl(forged, 'https://clubika.com')).toBe(false);
  });

  it('ne fait pas confiance à Host / X-Forwarded-Host en production', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = 'https://clubika.com';
    const forged = parseOriginHeader('https://evil.example')!;
    expect(isAllowedOriginUrl(forged, 'https://evil.example')).toBe(false);
  });

  it('autorise une origine listée dans CSRF_ALLOWED_ORIGINS', () => {
    process.env.NODE_ENV = 'production';
    process.env.APP_BASE_URL = 'https://clubika.com';
    process.env.CSRF_ALLOWED_ORIGINS = 'https://preview.clubika.test';
    const preview = parseOriginHeader('https://preview.clubika.test')!;
    expect(isAllowedOriginUrl(preview, 'https://clubika.com')).toBe(true);
  });

  it('autorise localhost hors production', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.APP_BASE_URL;
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
