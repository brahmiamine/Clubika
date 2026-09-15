import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Caddy TLS HSTS (issue #35)', () => {
  it('envoie HSTS progressif sans includeSubDomains ni preload', () => {
    const source = readFileSync(new URL('./Caddyfile', import.meta.url), 'utf8');
    const headerLines = source.split('\n').filter((line) => line.includes('Strict-Transport-Security'));
    expect(headerLines.length).toBeGreaterThanOrEqual(1);
    for (const line of headerLines) {
      expect(line).toContain('max-age=86400');
      expect(line).not.toMatch(/includeSubDomains/);
      expect(line).not.toMatch(/preload/);
    }
  });
});
