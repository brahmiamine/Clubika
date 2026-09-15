import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

function toBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function fromBase32(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number, digits: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter & 0xffff_ffff, 4);
  const hmac = createHmac('sha1', secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin = ((hmac[offset]! & 0x7f) << 24)
    | ((hmac[offset + 1]! & 0xff) << 16)
    | ((hmac[offset + 2]! & 0xff) << 8)
    | (hmac[offset + 3]! & 0xff);
  const otp = bin % (10 ** digits);
  return String(otp).padStart(digits, '0');
}

export function generateTotpSecret(): string {
  return toBase32(randomBytes(20));
}

export function generateTotp(secret: string, atMs: number = Date.now()): string {
  const key = fromBase32(secret);
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  return hotp(key, counter, TOTP_DIGITS);
}

export function verifyTotp(secret: string, token: string, atMs: number = Date.now()): boolean {
  const normalized = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return false;
  const key = fromBase32(secret);
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  const provided = Buffer.from(normalized);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const expected = Buffer.from(hotp(key, counter + offset, TOTP_DIGITS));
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return true;
    }
  }
  return false;
}

export function totpOtpauthUrl(secret: string, account: string, issuer = 'Clubika'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
