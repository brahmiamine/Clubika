import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getClientIp } from './client-ip';

function requestWithHeaders(headers: Record<string, string>) {
  return new NextRequest('http://localhost/api/auth/login', { headers });
}

describe('getClientIp (issue #29)', () => {
  const originalTrustedProxyCount = process.env.TRUSTED_PROXY_COUNT;
  const originalTrustProxyHeaders = process.env.TRUST_PROXY_HEADERS;

  afterEach(() => {
    if (originalTrustedProxyCount === undefined) delete process.env.TRUSTED_PROXY_COUNT;
    else process.env.TRUSTED_PROXY_COUNT = originalTrustedProxyCount;
    if (originalTrustProxyHeaders === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrustProxyHeaders;
  });

  it('ignore X-Forwarded-For tant qu\'aucun proxy n\'est explicitement déclaré', () => {
    delete process.env.TRUST_PROXY_HEADERS;
    delete process.env.TRUSTED_PROXY_COUNT;
    expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.7' }))).toBe('unknown');
    expect(getClientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.99' }))).toBe('unknown');
  });

  it('retient la seule entrée présente derrière un proxy de confiance', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    delete process.env.TRUSTED_PROXY_COUNT;
    expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.7' }))).toBe('203.0.113.7');
  });

  it('retient la Nième entrée en partant de la droite avec plusieurs proxies de confiance', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_COUNT = '2';
    expect(
      getClientIp(requestWithHeaders({
        'x-forwarded-for': '203.0.113.1, 198.51.100.9, 10.0.0.5',
      })),
    ).toBe('198.51.100.9');
  });

  it('ignore un préfixe falsifié par le client', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_COUNT = '1';
    expect(
      getClientIp(requestWithHeaders({ 'x-forwarded-for': '6.6.6.6, 203.0.113.42' })),
    ).toBe('203.0.113.42');
  });

  it('ignore TRUSTED_PROXY_COUNT=0 même si TRUST_PROXY_HEADERS est actif', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_COUNT = '0';
    expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.7' }))).toBe('unknown');
  });

  it('retombe sur x-real-ip quand x-forwarded-for est absent', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    expect(getClientIp(requestWithHeaders({ 'x-real-ip': '203.0.113.99' }))).toBe('203.0.113.99');
  });

  it('ignore une valeur non IP dans les en-têtes forwarded', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    expect(getClientIp(requestWithHeaders({ 'x-forwarded-for': 'not-an-ip' }))).toBe('unknown');
  });

  it('retombe sur "unknown" sans lever quand aucun en-tête exploitable n\'est présent', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    expect(getClientIp(requestWithHeaders({}))).toBe('unknown');
  });

  it('ne lève jamais avec TRUSTED_PROXY_COUNT invalide', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    process.env.TRUSTED_PROXY_COUNT = 'pas-un-nombre';
    expect(() => getClientIp(requestWithHeaders({ 'x-forwarded-for': '203.0.113.7' }))).not.toThrow();
  });
});
