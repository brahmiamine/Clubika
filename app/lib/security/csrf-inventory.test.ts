import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSRF_EXEMPT_PATHS } from './csrf';

function findRouteFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findRouteFiles(full, results);
    else if (entry === 'route.ts') results.push(full);
  }
  return results;
}

describe('inventaire des routes mutantes (issue #35)', () => {
  it('limite les exemptions CSRF à cron (Bearer) et aux rapports CSP', () => {
    expect([...CSRF_EXEMPT_PATHS].sort()).toEqual(['/api/cron', '/api/security/csp-report']);
  });

  it('toutes les routes API mutantes sont sous /api et donc couvertes par le proxy fail-closed', () => {
    const apiDir = join(process.cwd(), 'app/api');
    const mutating = findRouteFiles(apiDir).filter((file) => {
      const source = readFileSync(file, 'utf8');
      return /export async function (POST|PUT|PATCH|DELETE)\b/.test(source);
    });
    expect(mutating.length).toBeGreaterThan(10);
    for (const file of mutating) {
      expect(file.replace(/\\/g, '/')).toContain('/app/api/');
    }
  });
});
