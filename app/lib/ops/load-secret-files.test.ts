import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSecretFilesFromEnv } from './load-secret-files';

describe('loadSecretFilesFromEnv', () => {
  it('loads NAME from NAME_FILE without logging the value', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clubika-secret-'));
    const file = path.join(dir, 'key');
    writeFileSync(file, 'hex-secret-value\n', { mode: 0o600 });
    const env: Record<string, string | undefined> = { APP_ENCRYPTION_KEY_FILE: file };
    try {
      loadSecretFilesFromEnv(env);
      expect(env.APP_ENCRYPTION_KEY).toBe('hex-secret-value');
      expect(env.APP_ENCRYPTION_KEY_FILE).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to start when the secret file is unreadable', () => {
    const env: Record<string, string | undefined> = { CRON_SECRET_FILE: '/no/such/clubika-secret' };
    expect(() => loadSecretFilesFromEnv(env)).toThrow(/illisible/);
  });
});
