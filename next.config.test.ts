import { describe, expect, it } from 'vitest';
import nextConfig from './next.config';

describe('Permissions-Policy', () => {
  it('externalise TypeORM et le driver MariaDB hors du bundle API', () => {
    expect(nextConfig.serverExternalPackages).toEqual(
      expect.arrayContaining(['typeorm', 'mysql', 'mysql2', 'mariadb', 'reflect-metadata']),
    );
  });

  it('interdit le référent et l’indexation sur les pages d’invitation (issue #34)', async () => {
    const headersFn = nextConfig.headers;
    expect(headersFn).toEqual(expect.any(Function));
    const headers = await headersFn!();
    for (const source of ['/inscription', '/inscription/:path*']) {
      const entry = headers.find((candidate) => candidate.source === source)?.headers ?? [];
      expect(entry).toEqual(expect.arrayContaining([
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'private, no-store, max-age=0' },
        { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      ]));
    }
  });

  it('autorise le microphone de cette origine pour afficher le prompt navigateur', async () => {
    const headersFn = nextConfig.headers;
    expect(headersFn).toEqual(expect.any(Function));
    const headers = await headersFn!();
    const globalHeaders = headers.find((entry) => entry.source === '/(.*)')?.headers ?? [];
    const policy = globalHeaders.find((header) => header.key === 'Permissions-Policy')?.value ?? '';
    expect(policy).toContain('microphone=(self)');
    expect(policy).not.toMatch(/microphone=\(\s*\)/);
    const xss = globalHeaders.find((header) => header.key === 'X-XSS-Protection')?.value ?? '';
    expect(xss).toBe('0');
  });
});
