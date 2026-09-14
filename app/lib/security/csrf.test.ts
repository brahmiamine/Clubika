import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { enforceCsrf, isCsrfExemptPath } from './csrf';

function mutatingRequest(path: string, init?: { origin?: string | null; referer?: string; cookie?: boolean; method?: string }) {
  const headers = new Headers();
  if (init?.origin) headers.set('origin', init.origin);
  if (init?.referer) headers.set('referer', init.referer);
  if (init?.cookie) headers.set('cookie', `${SESSION_COOKIE_NAME}=${'a'.repeat(64)}`);
  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? 'POST',
    headers,
  });
}

describe('CSRF fail-closed (issue #35)', () => {
  it('laisse passer GET', () => {
    expect(enforceCsrf(mutatingRequest('/api/users', { method: 'GET', cookie: true }))).toBeNull();
  });

  it('refuse une mutation sans Origin ni Referer', () => {
    const response = enforceCsrf(mutatingRequest('/api/users', { cookie: true }));
    expect(response?.status).toBe(403);
  });

  it('refuse Origin null', () => {
    const response = enforceCsrf(mutatingRequest('/api/users', { origin: 'null', cookie: true }));
    expect(response?.status).toBe(403);
  });

  it('refuse une Origin cross-site', () => {
    const response = enforceCsrf(mutatingRequest('/api/users', {
      origin: 'https://evil.example',
      cookie: true,
    }));
    expect(response?.status).toBe(403);
  });

  it('accepte une Origin same-site', () => {
    expect(enforceCsrf(mutatingRequest('/api/users', {
      origin: 'http://localhost',
      cookie: true,
    }))).toBeNull();
  });

  it('accepte un Referer same-origin sans Origin', () => {
    expect(enforceCsrf(mutatingRequest('/api/users', {
      referer: 'http://localhost/club/users',
      cookie: true,
    }))).toBeNull();
  });

  it('protège les uploads cookie-authenticated', () => {
    expect(enforceCsrf(mutatingRequest('/api/chat/upload', {
      origin: 'https://evil.example',
      cookie: true,
    }))?.status).toBe(403);
  });

  it('exempte cron et rapports CSP uniquement', () => {
    expect(isCsrfExemptPath('/api/cron/scraper')).toBe(true);
    expect(isCsrfExemptPath('/api/security/csp-report')).toBe(true);
    expect(isCsrfExemptPath('/api/users')).toBe(false);
    expect(isCsrfExemptPath('/api/invitations/abc/accept')).toBe(false);
    expect(enforceCsrf(mutatingRequest('/api/cron/scraper'))).toBeNull();
    expect(enforceCsrf(mutatingRequest('/api/security/csp-report'))).toBeNull();
  });
});
