import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertEncryptionConfiguredForProduction } from './secret-box';

const ORIGINAL = {
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY,
  APP_ENCRYPTION_KEY_ID: process.env.APP_ENCRYPTION_KEY_ID,
  APP_ENCRYPTION_PREVIOUS_KEYS: process.env.APP_ENCRYPTION_PREVIOUS_KEYS,
};

async function freshSecretBox() {
  vi.resetModules();
  return import('./secret-box') as Promise<typeof import('./secret-box')>;
}

function encV1(plaintext: string, secret: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

afterEach(() => {
  if (ORIGINAL.APP_ENCRYPTION_KEY === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = ORIGINAL.APP_ENCRYPTION_KEY;
  if (ORIGINAL.APP_ENCRYPTION_KEY_ID === undefined) delete process.env.APP_ENCRYPTION_KEY_ID;
  else process.env.APP_ENCRYPTION_KEY_ID = ORIGINAL.APP_ENCRYPTION_KEY_ID;
  if (ORIGINAL.APP_ENCRYPTION_PREVIOUS_KEYS === undefined) delete process.env.APP_ENCRYPTION_PREVIOUS_KEYS;
  else process.env.APP_ENCRYPTION_PREVIOUS_KEYS = ORIGINAL.APP_ENCRYPTION_PREVIOUS_KEYS;
});

describe('assertEncryptionConfiguredForProduction (issue #212)', () => {
  it('refuse le démarrage en production sans clé configurée', () => {
    expect(() => assertEncryptionConfiguredForProduction('production', false)).toThrow(
      /APP_ENCRYPTION_KEY est requis en production/,
    );
  });

  it('ne bloque pas la production quand la clé est configurée', () => {
    expect(() => assertEncryptionConfiguredForProduction('production', true)).not.toThrow();
  });

  it('tolère la dégradation en développement (comportement distinct de la production)', () => {
    expect(() => assertEncryptionConfiguredForProduction('development', false)).not.toThrow();
    expect(() => assertEncryptionConfiguredForProduction(undefined, false)).not.toThrow();
  });
});

describe('encryptSecret / decryptSecret (issue #24)', () => {
  it('round-trips a value regardless of whether APP_ENCRYPTION_KEY is configured in this environment', async () => {
    const { encryptSecret, decryptSecret } = await freshSecretBox();
    const plaintext = 'plain-value';
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it('two encryptions of the same plaintext differ (random IV)', async () => {
    process.env.APP_ENCRYPTION_KEY = 'unit-test-key-material';
    process.env.APP_ENCRYPTION_KEY_ID = 'k1';
    const { encryptSecret } = await freshSecretBox();
    const a = encryptSecret('same-plain');
    const b = encryptSecret('same-plain');
    expect(a).not.toBe(b);
    expect(a.startsWith('enc:v2:k1:')).toBe(true);
  });

  it('rejects a tampered ciphertext', async () => {
    process.env.APP_ENCRYPTION_KEY = 'unit-test-key-material';
    const { encryptSecret, decryptSecret } = await freshSecretBox();
    const stored = encryptSecret('secret-content');
    const tampered = `${stored.slice(0, -2)}aa`;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(decryptSecret(tampered)).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('decrypts a legacy enc:v1 envelope with the previous key during rotation', async () => {
    const v1 = encV1('historique', 'old-key-material');
    process.env.APP_ENCRYPTION_KEY = 'new-key-material';
    process.env.APP_ENCRYPTION_KEY_ID = 'k2';
    process.env.APP_ENCRYPTION_PREVIOUS_KEYS = 'k1:old-key-material';
    const { decryptSecret, reencryptSecret, envelopeKeyId } = await freshSecretBox();
    expect(decryptSecret(v1)).toBe('historique');
    const rotated = reencryptSecret(v1);
    expect(rotated).toBeTruthy();
    expect(envelopeKeyId(rotated!)).toBe('k2');
    expect(decryptSecret(rotated!)).toBe('historique');
  });

  it('cannot decrypt after the old key is retired', async () => {
    const v1 = encV1('historique', 'old-key-material');
    process.env.APP_ENCRYPTION_KEY = 'new-key-material';
    process.env.APP_ENCRYPTION_KEY_ID = 'k2';
    delete process.env.APP_ENCRYPTION_PREVIOUS_KEYS;
    const { decryptSecret } = await freshSecretBox();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(decryptSecret(v1)).toBeNull();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('returns legacy plaintext (no enc prefix) unchanged, even without a key', async () => {
    process.env.APP_ENCRYPTION_KEY = '';
    const fresh = await freshSecretBox();
    expect(fresh.decryptSecret('donnée historique en clair')).toBe('donnée historique en clair');
  });

  it('logs and returns null instead of the ciphertext when no key is configured (issue #261)', async () => {
    process.env.APP_ENCRYPTION_KEY = 'first-key';
    const withKey = await freshSecretBox();
    const stored = withKey.encryptSecret('secret-content');

    process.env.APP_ENCRYPTION_KEY = '';
    const withoutKey = await freshSecretBox();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = withoutKey.decryptSecret(stored);
      expect(result).toBeNull();
      expect(result).not.toBe(stored);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs and returns null instead of the ciphertext when the key changed without previous keys (issue #261)', async () => {
    process.env.APP_ENCRYPTION_KEY = 'original-key';
    const withOriginalKey = await freshSecretBox();
    const stored = withOriginalKey.encryptSecret('secret-content');

    process.env.APP_ENCRYPTION_KEY = 'a-completely-different-key';
    const withRotatedKey = await freshSecretBox();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = withRotatedKey.decryptSecret(stored);
      expect(result).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('round-trips plaintext that coincidentally starts with the envelope prefix, without a key', async () => {
    process.env.APP_ENCRYPTION_KEY = '';
    const fresh = await freshSecretBox();
    const coincidental = 'enc:v1:ceci ressemble à une enveloppe mais ne l’est pas';

    const stored = fresh.encryptSecret(coincidental);
    expect(stored).not.toBe(coincidental);
    expect(fresh.decryptSecret(stored)).toBe(coincidental);
  });
});
