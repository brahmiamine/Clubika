import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const MAGIC = Buffer.from('CBK1');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_ID_BYTES = 32;

function backupKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function padKeyId(keyId: string): Buffer {
  const buf = Buffer.alloc(KEY_ID_BYTES, 0);
  buf.write(keyId.slice(0, KEY_ID_BYTES), 0, 'utf8');
  return buf;
}

function readKeyId(buf: Buffer): string {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

/**
 * Fichier de sauvegarde : MAGIC || keyId[32] || iv[12] || tag[16] || ciphertext.
 * Clé : BACKUP_ENCRYPTION_KEY (distincte de APP_ENCRYPTION_KEY).
 */
export function encryptBackup(plaintext: Buffer, secret: string, keyId = 'b1'): Buffer {
  const key = backupKey(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, padKeyId(keyId), iv, tag, ciphertext]);
}

export function decryptBackup(blob: Buffer, secret: string): Buffer {
  if (blob.length < MAGIC.length + KEY_ID_BYTES + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Sauvegarde trop courte');
  }
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Format de sauvegarde inconnu');
  }
  const ivStart = MAGIC.length + KEY_ID_BYTES;
  const iv = blob.subarray(ivStart, ivStart + IV_LENGTH);
  const tag = blob.subarray(ivStart + IV_LENGTH, ivStart + IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(ivStart + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, backupKey(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function backupFingerprint(blob: Buffer): string {
  return createHash('sha256').update(blob).digest('hex');
}

export function backupKeyId(blob: Buffer): string | null {
  if (blob.length < MAGIC.length + KEY_ID_BYTES) return null;
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  return readKeyId(blob.subarray(MAGIC.length, MAGIC.length + KEY_ID_BYTES));
}
