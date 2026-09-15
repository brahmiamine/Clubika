import { describe, expect, it } from 'vitest';
import { backupFingerprint, decryptBackup, encryptBackup } from './backup-box';

describe('backup-box AEAD (issue #24)', () => {
  it('round-trip et IV distincts, refuse une altération', () => {
    const secret = 'backup-key-material';
    const plain = Buffer.from('-- MariaDB dump\nSELECT 1;\n');
    const a = encryptBackup(plain, secret);
    const b = encryptBackup(plain, secret);
    expect(a.equals(b)).toBe(false);
    expect(decryptBackup(a, secret).equals(plain)).toBe(true);
    const tampered = Buffer.from(a);
    const last = tampered.length - 1;
    tampered.writeUInt8((tampered[last] ?? 0) ^ 0xff, last);
    expect(() => decryptBackup(tampered, secret)).toThrow();
    expect(backupFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuse une autre BACKUP_ENCRYPTION_KEY', () => {
    const blob = encryptBackup(Buffer.from('gzip-bytes'), 'key-a');
    expect(() => decryptBackup(blob, 'key-b')).toThrow();
  });
});
