import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('sauvegardes MariaDB (issue #24)', () => {
  it('refuse un dump en clair sans BACKUP_ENCRYPTION_KEY', () => {
    const source = readFileSync(new URL('./scripts/backup-mariadb.sh', import.meta.url), 'utf8');
    expect(source).toContain('BACKUP_ENCRYPTION_KEY');
    expect(source).toContain('refus d’écrire un dump en clair');
    expect(source).toContain('.sql.gz.enc');
    expect(source).not.toMatch(/gzip -c > "\$OUT"/);
  });

  it('documente verify puis restore isolé', () => {
    const source = readFileSync(new URL('./scripts/restore-mariadb.sh', import.meta.url), 'utf8');
    expect(source).toContain('--verify');
    expect(source).toContain('--restore');
    expect(source).toContain('sha256');
  });
});
