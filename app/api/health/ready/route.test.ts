import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from './route';

const originalHost = process.env.DB_HOST;
const originalPort = process.env.DB_PORT;

afterEach(() => {
  if (originalHost === undefined) delete process.env.DB_HOST;
  else process.env.DB_HOST = originalHost;
  if (originalPort === undefined) delete process.env.DB_PORT;
  else process.env.DB_PORT = originalPort;
});

describe('GET /api/health/ready', () => {
  it('returns a generic 503 when the database is unreachable', async () => {
    process.env.DB_HOST = '127.0.0.1';
    process.env.DB_PORT = '1';
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ status: 'not-ready' });
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toMatch(/sql|password|access denied|econnrefused|mariadb/);
  });

  it('does not import getDb (no tenant bootstrap on the probe)', () => {
    const source = readFileSync(path.join(process.cwd(), 'app/api/health/ready/route.ts'), 'utf8');
    expect(source).not.toContain("from '@/lib/db'");
    expect(source).not.toContain('getDb');
    expect(source).toContain('pingDatabaseForReadiness');
  });
});
