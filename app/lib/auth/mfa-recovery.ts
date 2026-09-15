import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const RECOVERY_CODE_COUNT = 10;

function recoveryPepper(): string {
  return process.env.APP_ENCRYPTION_KEY?.trim()
    || process.env.MFA_RECOVERY_PEPPER?.trim()
    || 'dev-only-mfa-recovery-pepper';
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHmac('sha256', recoveryPepper()).update(normalizeRecoveryCode(code)).digest('hex');
}

export function recoveryCodesMatch(code: string, storedHash: string): boolean {
  const computed = Buffer.from(hashRecoveryCode(code), 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = randomBytes(5).toString('hex').toUpperCase();
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}
