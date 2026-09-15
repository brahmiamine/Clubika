import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  passwordNeedsRehash,
  UNUSABLE_PASSWORD_HASH,
  verifyPassword,
  verifyPasswordAndMaybeRehash,
} from './password';

describe('password hashing', () => {
  it('hashes and verifies a correct password with a versioned format', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash.startsWith('v1:scrypt:')).toBe(true);
    expect(await verifyPassword('correct-horse-battery-staple', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('produces a different hash (different salt) for the same password', async () => {
    const hashA = await hashPassword('same-password');
    const hashB = await hashPassword('same-password');
    expect(hashA).not.toBe(hashB);
    expect(await verifyPassword('same-password', hashA)).toBe(true);
    expect(await verifyPassword('same-password', hashB)).toBe(true);
  });

  it('rejects a malformed stored hash and the unusable sentinel', async () => {
    expect(await verifyPassword('anything', 'not-a-valid-hash')).toBe(false);
    expect(await verifyPassword('anything', 'bcrypt:1:2:3:aa:bb')).toBe(false);
    expect(await verifyPassword('anything', UNUSABLE_PASSWORD_HASH)).toBe(false);
  });

  it('still verifies a legacy unversioned scrypt hash and marks it for rehash', async () => {
    const { promisify } = await import('node:util');
    const { randomBytes, scrypt } = await import('node:crypto');
    const scryptAsync = promisify(scrypt) as (
      password: string,
      salt: Buffer,
      keylen: number,
      options: { N: number; r: number; p: number },
    ) => Promise<Buffer>;
    const salt = randomBytes(16);
    const derived = await scryptAsync('legacy-passphrase', salt, 64, { N: 16384, r: 8, p: 1 });
    const legacy = `scrypt:16384:8:1:${salt.toString('hex')}:${derived.toString('hex')}`;
    expect(await verifyPassword('legacy-passphrase', legacy)).toBe(true);
    expect(passwordNeedsRehash(legacy)).toBe(true);
    const result = await verifyPasswordAndMaybeRehash('legacy-passphrase', legacy);
    expect(result.ok).toBe(true);
    expect(result.newHash?.startsWith('v1:scrypt:')).toBe(true);
  });
});
