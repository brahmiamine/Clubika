import { logError, logWarn } from '@/lib/observability/log';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const ENVELOPE_PREFIX = 'enc:v1:';
/**
 * Marqueur d'échappement : sans clé configurée, `encryptSecret` stocke le texte tel
 * quel (voir plus bas). Si ce texte en clair commence, par coïncidence, par
 * `ENVELOPE_PREFIX`, `decryptSecret` le prendrait pour une enveloppe chiffrée. On
 * l'échappe explicitement avec ce préfixe pour lever toute ambiguïté à la lecture.
 */
const PLAINTEXT_ESCAPE_PREFIX = 'plain:v1:';

let cachedKey: Buffer | null | undefined;

/**
 * Dérive une clé AES-256 stable à partir de APP_ENCRYPTION_KEY (hex/base64/texte).
 * Le hash SHA-256 garantit toujours 32 octets quel que soit le format fourni.
 */
function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const secret = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!secret) {
    cachedKey = null;
    logWarn('app.unhandled', 
      '[crypto] APP_ENCRYPTION_KEY non défini — les messages de chat et les mots de passe SMTP sont enregistrés en clair. Définissez cette variable avant la mise en production.',
    );
    return null;
  }
  cachedKey = createHash('sha256').update(secret).digest();
  return cachedKey;
}

export function isEncryptionConfigured(): boolean {
  return getKey() !== null;
}

/**
 * En développement, l'absence de clé dégrade silencieusement en clair (cf. `encryptSecret`) —
 * pratique pour démarrer sans configuration. En production, cette dégradation ne doit plus être
 * silencieuse : on refuse le démarrage plutôt que d'enregistrer des secrets en clair (issue #212).
 */
export function assertEncryptionConfiguredForProduction(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  encryptionConfigured: boolean = isEncryptionConfigured(),
): void {
  if (nodeEnv === 'production' && !encryptionConfigured) {
    throw new Error(
      'APP_ENCRYPTION_KEY est requis en production : sans cette variable, les messages de chat et '
      + 'les mots de passe SMTP seraient enregistrés en clair. Définissez-la avant de démarrer l\'application.',
    );
  }
}

/**
 * Chiffre une chaîne. Retourne le texte tel quel si aucune clé n'est configurée (dev) —
 * sauf s'il commence par `ENVELOPE_PREFIX` (ou son propre marqueur d'échappement), auquel
 * cas il est échappé pour ne pas être confondu avec une enveloppe chiffrée à la lecture.
 */
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  if (!key) {
    return plaintext.startsWith(ENVELOPE_PREFIX) || plaintext.startsWith(PLAINTEXT_ESCAPE_PREFIX)
      ? PLAINTEXT_ESCAPE_PREFIX + plaintext
      : plaintext;
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ENVELOPE_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Déchiffre. Les valeurs sans préfixe d'enveloppe (données historiques en clair) sont
 * renvoyées telles quelles. En cas d'échec — clé absente alors qu'une valeur chiffrée
 * existe, clé changée, ou donnée corrompue — journalise l'erreur et renvoie `null`
 * plutôt que le texte chiffré tel quel : le laisser fuiter tel quel (base64 illisible)
 * dans un DTO ou un mot de passe SMTP passerait inaperçu côté exploitation (issue #261).
 */
export function decryptSecret(stored: string): string | null {
  if (stored.startsWith(PLAINTEXT_ESCAPE_PREFIX)) return stored.slice(PLAINTEXT_ESCAPE_PREFIX.length);
  if (!stored.startsWith(ENVELOPE_PREFIX)) return stored;
  const key = getKey();
  if (!key) {
    logError('crypto.decrypt_failed');
    return null;
  }
  try {
    const raw = Buffer.from(stored.slice(ENVELOPE_PREFIX.length), 'base64');
    const iv = raw.subarray(0, IV_LENGTH);
    const tag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
    const ciphertext = raw.subarray(IV_LENGTH + 16);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (error) {
    logError('app.unhandled', '[crypto] Déchiffrement impossible : clé invalide ou donnée corrompue.', error);
    return null;
  }
}
