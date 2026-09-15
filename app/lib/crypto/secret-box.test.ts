import { afterEach, describe, it, expect, vi } from 'vitest';
import { assertEncryptionConfiguredForProduction, decryptSecret, encryptSecret } from './secret-box';

const ORIGINAL_KEY = process.env.APP_ENCRYPTION_KEY;

/** Le module mémoïse la clé dérivée au premier appel : un import frais est nécessaire
 * pour observer un changement de APP_ENCRYPTION_KEY au sein d'un même fichier de test. */
async function freshSecretBox() {
  vi.resetModules();
  return import('./secret-box') as Promise<typeof import('./secret-box')>;
}

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

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a value regardless of whether APP_ENCRYPTION_KEY is configured in this environment', () => {
    const plaintext = 'plain-value';
    const stored = encryptSecret(plaintext);
    expect(decryptSecret(stored)).toBe(plaintext);
  });

  it('returns legacy plaintext (no enc:v1: prefix) unchanged, even without a key', async () => {
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
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = withoutKey.decryptSecret(stored);
      // Ne renvoie jamais le texte chiffré tel quel : soit le texte en clair déchiffré,
      // soit null — jamais la valeur stockée (préfixée enc:v1:).
      expect(result).toBeNull();
      expect(result).not.toBe(stored);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs and returns null instead of the ciphertext when the key changed (issue #261)', async () => {
    process.env.APP_ENCRYPTION_KEY = 'original-key';
    const withOriginalKey = await freshSecretBox();
    const stored = withOriginalKey.encryptSecret('secret-content');

    process.env.APP_ENCRYPTION_KEY = 'a-completely-different-key';
    const withRotatedKey = await freshSecretBox();
    const errorSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
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
    expect(stored).not.toBe(coincidental); // échappé, sinon confondu avec une vraie enveloppe
    expect(fresh.decryptSecret(stored)).toBe(coincidental);
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = ORIGINAL_KEY;
  });
});
