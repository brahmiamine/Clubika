import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const ENVELOPE_V1 = 'enc:v1:';
const ENVELOPE_V2 = 'enc:v2:';
const PLAINTEXT_ESCAPE_PREFIX = 'plain:v1:';
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export const CURRENT_ENVELOPE_VERSION = 'v2' as const;

interface KeyRing {
  activeId: string;
  keys: Map<string, Buffer>;
}

let cachedRing: KeyRing | null | undefined;

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function parsePreviousKeys(raw: string | undefined): Map<string, Buffer> {
  const map = new Map<string, Buffer>();
  if (!raw?.trim()) return map;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon <= 0) continue;
    const id = trimmed.slice(0, colon).trim();
    const material = trimmed.slice(colon + 1);
    if (!KEY_ID_PATTERN.test(id) || !material) continue;
    map.set(id, deriveKey(material));
  }
  return map;
}

function loadKeyRing(): KeyRing | null {
  if (cachedRing !== undefined) return cachedRing;
  const secret = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!secret) {
    cachedRing = null;
    console.warn(
      '[crypto] APP_ENCRYPTION_KEY non défini — les messages de chat et les mots de passe SMTP sont enregistrés en clair. Définissez cette variable avant la mise en production.',
    );
    return null;
  }
  const activeId = (process.env.APP_ENCRYPTION_KEY_ID?.trim() || 'k1');
  if (!KEY_ID_PATTERN.test(activeId)) {
    cachedRing = null;
    console.error('[crypto] APP_ENCRYPTION_KEY_ID invalide.');
    return null;
  }
  const keys = parsePreviousKeys(process.env.APP_ENCRYPTION_PREVIOUS_KEYS);
  keys.set(activeId, deriveKey(secret));
  cachedRing = { activeId, keys };
  return cachedRing;
}

/** Tests : oublier l’anneau mémoïsé après un changement d’env. */
export function resetEncryptionKeyCache(): void {
  cachedRing = undefined;
}

export function isEncryptionConfigured(): boolean {
  return loadKeyRing() !== null;
}

export function activeEncryptionKeyId(): string | null {
  return loadKeyRing()?.activeId ?? null;
}

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

function seal(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function open(raw: Buffer, key: Buffer): string {
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function encryptSecret(plaintext: string): string {
  const ring = loadKeyRing();
  if (!ring) {
    return plaintext.startsWith(ENVELOPE_V1) || plaintext.startsWith(ENVELOPE_V2) || plaintext.startsWith(PLAINTEXT_ESCAPE_PREFIX)
      ? PLAINTEXT_ESCAPE_PREFIX + plaintext
      : plaintext;
  }
  const payload = seal(plaintext, ring.keys.get(ring.activeId)!).toString('base64');
  return `${ENVELOPE_V2}${ring.activeId}:${payload}`;
}

function decryptV1(stored: string, ring: KeyRing): string | null {
  const raw = Buffer.from(stored.slice(ENVELOPE_V1.length), 'base64');
  const ordered = [ring.activeId, ...[...ring.keys.keys()].filter((id) => id !== ring.activeId)];
  for (const id of ordered) {
    const key = ring.keys.get(id);
    if (!key) continue;
    try {
      return open(raw, key);
    } catch {
      continue;
    }
  }
  return null;
}

function decryptV2(stored: string, ring: KeyRing): string | null {
  const rest = stored.slice(ENVELOPE_V2.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const keyId = rest.slice(0, colon);
  const payload = rest.slice(colon + 1);
  const key = ring.keys.get(keyId);
  if (!key) return null;
  try {
    return open(Buffer.from(payload, 'base64'), key);
  } catch {
    return null;
  }
}

export function decryptSecret(stored: string): string | null {
  if (stored.startsWith(PLAINTEXT_ESCAPE_PREFIX)) return stored.slice(PLAINTEXT_ESCAPE_PREFIX.length);
  const isV1 = stored.startsWith(ENVELOPE_V1);
  const isV2 = stored.startsWith(ENVELOPE_V2);
  if (!isV1 && !isV2) return stored;

  const ring = loadKeyRing();
  if (!ring) {
    console.error(
      '[crypto] Déchiffrement impossible : APP_ENCRYPTION_KEY non défini alors qu\'une valeur chiffrée existe.',
    );
    return null;
  }
  const plain = isV2 ? decryptV2(stored, ring) : decryptV1(stored, ring);
  if (plain === null) {
    console.error('[crypto] Déchiffrement impossible : clé invalide, key-id inconnu ou donnée corrompue.');
  }
  return plain;
}

export type EnvelopeKind = 'plaintext' | 'escaped' | 'enc-v1' | 'enc-v2';

export function classifyEnvelope(stored: string): EnvelopeKind {
  if (stored.startsWith(PLAINTEXT_ESCAPE_PREFIX)) return 'escaped';
  if (stored.startsWith(ENVELOPE_V2)) return 'enc-v2';
  if (stored.startsWith(ENVELOPE_V1)) return 'enc-v1';
  return 'plaintext';
}

export function envelopeKeyId(stored: string): string | null {
  if (!stored.startsWith(ENVELOPE_V2)) return null;
  const rest = stored.slice(ENVELOPE_V2.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  return rest.slice(0, colon);
}

export function needsReencrypt(stored: string): boolean {
  const ring = loadKeyRing();
  if (!ring) return false;
  if (classifyEnvelope(stored) !== 'enc-v2') return classifyEnvelope(stored) !== 'escaped';
  return envelopeKeyId(stored) !== ring.activeId;
}

/** Déchiffre puis re-chiffre avec la clé active (rotation). */
export function reencryptSecret(stored: string): string | null {
  const plain = decryptSecret(stored);
  if (plain === null) return null;
  return encryptSecret(plain);
}
