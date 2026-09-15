import { describe, expect, it } from 'vitest';
import { generateTotp, generateTotpSecret, totpOtpauthUrl, verifyTotp } from './totp';

describe('TOTP (issue #32)', () => {
  it('round-trips a freshly generated secret', () => {
    const secret = generateTotpSecret();
    const at = Date.UTC(2026, 0, 15, 12, 0, 0);
    const token = generateTotp(secret, at);
    expect(token).toMatch(/^\d{6}$/);
    expect(verifyTotp(secret, token, at)).toBe(true);
    expect(verifyTotp(secret, '000000', at)).toBe(false);
  });

  it('accepts a token from the neighbouring 30s window', () => {
    const secret = generateTotpSecret();
    const at = Date.UTC(2026, 0, 15, 12, 0, 5);
    const previous = generateTotp(secret, at - 30_000);
    expect(verifyTotp(secret, previous, at)).toBe(true);
  });

  it('builds an otpauth URL that never embeds a Host header', () => {
    const url = totpOtpauthUrl('MFRGGZDFMZTWQ2LK', 'ops@example.com');
    expect(url).toContain('otpauth://totp/');
    expect(url).toContain('ops%40example.com');
    expect(url).not.toContain('http://');
  });
});
