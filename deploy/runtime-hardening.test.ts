import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function parseLock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const lock = parseLock(readFileSync(path.join(process.cwd(), 'deploy/runtime-images.lock'), 'utf8'));
const dockerfile = readFileSync(path.join(process.cwd(), 'Dockerfile'), 'utf8');
const compose = readFileSync(path.join(process.cwd(), 'deploy/docker-compose.yml'), 'utf8');
const ci = readFileSync(path.join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const start = readFileSync(path.join(process.cwd(), 'start.sh'), 'utf8');

describe('runtime image pins (issue #36)', () => {
  it('locks node, mariadb, caddy and phpmyadmin to a digest', () => {
    for (const key of ['NODE_IMAGE', 'MARIADB_IMAGE', 'CADDY_IMAGE', 'PHPMYADMIN_IMAGE']) {
      expect(lock[key], key).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(lock[key]).not.toContain(':latest');
    }
    expect(lock.APP_UID).toBe('10001');
    expect(lock.APP_GID).toBe('10001');
  });

  it('keeps Dockerfile, compose, CI and start.sh in sync with the lock file', () => {
    expect(dockerfile).toContain(lock.NODE_IMAGE);
    expect(dockerfile).toContain('USER 10001:10001');
    expect(dockerfile).not.toContain('playwright install');
    expect(compose).toContain(lock.MARIADB_IMAGE);
    expect(compose).toContain(lock.CADDY_IMAGE);
    expect(ci).toContain(lock.MARIADB_IMAGE);
    expect(ci).not.toMatch(/mariadb:latest/);
    expect(start).toContain(lock.MARIADB_IMAGE);
    expect(start).toContain(lock.PHPMYADMIN_IMAGE);
    expect(start).not.toMatch(/mariadb:latest|phpmyadmin:latest/);
  });
});

describe('production compose hardening (issue #36)', () => {
  it('runs the app as a fixed non-root user with read-only rootfs and no capabilities', () => {
    expect(compose).toMatch(/user:\s+"10001:10001"/);
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('- ALL');
    expect(compose).toContain('pids_limit:');
    expect(compose).toContain('mem_limit:');
  });

  it('keeps MariaDB off the public network and on an internal backend network', () => {
    expect(compose).toContain('internal: true');
    expect(compose).not.toMatch(/3306:3306/);
    expect(compose).toContain('127.0.0.1:3000:3000');
    expect(compose).toContain('MARIADB_PASSWORD_FILE:');
    expect(compose).toContain('DB_PASSWORD_FILE:');
  });

  it('does not publish phpMyAdmin in production compose', () => {
    expect(compose.toLowerCase()).not.toContain('phpmyadmin');
  });
});
