import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * OpenSSL scrypt rejects parameters when `128 * N * r * p` equals the default
 * 32 MiB `maxmem`. Production N=32768, r=8, p=1 is exactly 32 MiB, so we pass
 * an explicit ceiling (Playwright uses NODE_ENV=production and would otherwise fail).
 */
function scryptMaxmem(N: number, r: number, p: number): number {
  return Math.max(64 * 1024 * 1024, 128 * N * r * p * 2);
}

/**
 * Format versionné (issue #32) : `v1:scrypt:N:r:p:saltHex:hashHex`.
 * Les empreintes historiques `scrypt:N:r:p:saltHex:hashHex` restent vérifiables
 * et sont réécrites (rehash opportuniste) au prochain login réussi.
 *
 * Paramètres évalués (2026) : OWASP recommande scrypt N=2^17 pour le stockage.
 * Le plancher intégré est N=2^15 hors tests (latence interactive) ; jamais
 * d'affaiblissement : un hash déjà plus coûteux n'est pas réécrit vers un N
 * inférieur. `PASSWORD_SCRYPT_N` (puissance de 2 ≥ 16384) permet de monter.
 */
export const PASSWORD_HASH_VERSION = 1;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const MIN_N = 16384;

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

export function currentScryptN(): number {
  const raw = Number.parseInt(process.env.PASSWORD_SCRYPT_N ?? '', 10);
  if (Number.isFinite(raw) && raw >= MIN_N && isPowerOfTwo(raw)) return raw;
  return process.env.NODE_ENV === 'test' ? MIN_N : 32768;
}

/** Empreinte volontairement invérifiable : profil sans accès, jamais un secret connu. */
export const UNUSABLE_PASSWORD_HASH = 'unusable';

type ParsedHash = {
  version: number | null;
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  expected: Buffer;
};

function parseStoredHash(stored: string): ParsedHash | null {
  if (!stored || stored === UNUSABLE_PASSWORD_HASH) return null;
  const parts = stored.split(':');
  let version: number | null = null;
  let scheme: string | undefined;
  let nRaw: string | undefined;
  let rRaw: string | undefined;
  let pRaw: string | undefined;
  let saltHex: string | undefined;
  let hashHex: string | undefined;

  if (parts[0]?.startsWith('v') && parts.length === 7) {
    const parsedVersion = Number.parseInt(parts[0].slice(1), 10);
    if (!Number.isFinite(parsedVersion) || parsedVersion < 1) return null;
    version = parsedVersion;
    [, scheme, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  } else if (parts.length === 6) {
    [scheme, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  } else {
    return null;
  }

  if (scheme !== 'scrypt' || !nRaw || !rRaw || !pRaw || !saltHex || !hashHex) return null;
  const N = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || N < MIN_N) return null;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (salt.length === 0 || expected.length === 0) return null;
  return { version, N, r, p, salt, expected };
}

export async function hashPassword(password: string): Promise<string> {
  const N = currentScryptN();
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, {
    N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: scryptMaxmem(N, SCRYPT_R, SCRYPT_P),
  });
  return `v${PASSWORD_HASH_VERSION}:scrypt:${N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const derived = await scryptAsync(password, parsed.salt, parsed.expected.length, {
    N: parsed.N,
    r: parsed.r,
    p: parsed.p,
    maxmem: scryptMaxmem(parsed.N, parsed.r, parsed.p),
  });
  return derived.length === parsed.expected.length && timingSafeEqual(derived, parsed.expected);
}

export function passwordNeedsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const currentN = currentScryptN();
  if (parsed.N > currentN) return false;
  if (parsed.N < currentN) return true;
  if (parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P) return true;
  return parsed.version !== PASSWORD_HASH_VERSION;
}

export async function verifyPasswordAndMaybeRehash(
  password: string,
  stored: string,
): Promise<{ ok: boolean; newHash?: string }> {
  const ok = await verifyPassword(password, stored);
  if (!ok) return { ok: false };
  if (!passwordNeedsRehash(stored)) return { ok: true };
  return { ok: true, newHash: await hashPassword(password) };
}
