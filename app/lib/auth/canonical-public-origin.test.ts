import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCanonicalPublicOriginForProduction,
  CanonicalPublicOriginError,
  requireCanonicalPublicOrigin,
  resolveCanonicalPublicOrigin,
  sensitiveAbsoluteUrl,
} from './canonical-public-origin';

const ORIGINAL_BASE = process.env.APP_BASE_URL;
const ORIGINAL_ALLOWLIST = process.env.APP_PUBLIC_ORIGIN_ALLOWLIST;

afterEach(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = ORIGINAL_BASE;
  if (ORIGINAL_ALLOWLIST === undefined) delete process.env.APP_PUBLIC_ORIGIN_ALLOWLIST;
  else process.env.APP_PUBLIC_ORIGIN_ALLOWLIST = ORIGINAL_ALLOWLIST;
});

describe('resolveCanonicalPublicOrigin (issue #32)', () => {
  it('returns the origin of APP_BASE_URL and ignores a forged host', () => {
    process.env.APP_BASE_URL = 'https://planning.exemple.fr/app';
    expect(resolveCanonicalPublicOrigin('production')).toBe('https://planning.exemple.fr');
  });

  it('rejects http and localhost in production', () => {
    process.env.APP_BASE_URL = 'http://planning.exemple.fr';
    expect(resolveCanonicalPublicOrigin('production')).toBeNull();
    process.env.APP_BASE_URL = 'https://localhost';
    expect(resolveCanonicalPublicOrigin('production')).toBeNull();
  });

  it('allows http localhost outside production', () => {
    process.env.APP_BASE_URL = 'http://localhost:3000';
    expect(resolveCanonicalPublicOrigin('test')).toBe('http://localhost:3000');
  });

  it('rejects credentials in the URL', () => {
    process.env.APP_BASE_URL = 'https://user:pass@planning.exemple.fr';
    expect(resolveCanonicalPublicOrigin('production')).toBeNull();
  });

  it('rejects an origin absent from the allowlist', () => {
    process.env.APP_BASE_URL = 'https://planning.exemple.fr';
    process.env.APP_PUBLIC_ORIGIN_ALLOWLIST = 'https://autre.exemple.fr';
    expect(resolveCanonicalPublicOrigin('production')).toBeNull();
  });
});

describe('requireCanonicalPublicOrigin / boot (issue #32)', () => {
  it('throws in production when APP_BASE_URL is missing', () => {
    delete process.env.APP_BASE_URL;
    expect(() => requireCanonicalPublicOrigin('production')).toThrow(CanonicalPublicOriginError);
    expect(() => assertCanonicalPublicOriginForProduction('production')).toThrow(/APP_BASE_URL/);
  });

  it('does not throw outside production when APP_BASE_URL is missing', () => {
    delete process.env.APP_BASE_URL;
    expect(() => assertCanonicalPublicOriginForProduction('test')).not.toThrow();
  });

  it('builds a sensitive link from the canonical origin only', () => {
    process.env.APP_BASE_URL = 'https://planning.exemple.fr';
    expect(sensitiveAbsoluteUrl('/reinitialiser/abc', 'production')).toBe(
      'https://planning.exemple.fr/reinitialiser/abc',
    );
  });
});
