import { createHash, randomBytes } from 'node:crypto';
import { IsNull } from 'typeorm';
import type { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type {
  PlatformAdminEntity,
  PlatformMfaChallengeEntity,
  PlatformMfaRecoveryCodeEntity,
} from '@/lib/db/schemas';
import { encryptSecret, decryptSecret } from '@/lib/crypto/secret-box';
import { PLATFORM_MFA_PENDING_COOKIE_NAME } from './constants';
import { generateRecoveryCodes, hashRecoveryCode } from './mfa-recovery';
import { generateTotpSecret, totpOtpauthUrl, verifyTotp } from './totp';

export const MFA_CHALLENGE_TTL_MS = 10 * 60 * 1000;

export type MfaChallengePurpose = 'login' | 'enroll' | 'stepup';

function hashChallengeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function setMfaPendingCookie(response: NextResponse, rawToken: string, expiresAt: Date): void {
  response.cookies.set(PLATFORM_MFA_PENDING_COOKIE_NAME, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

export function clearMfaPendingCookie(response: NextResponse): void {
  response.cookies.set(PLATFORM_MFA_PENDING_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: new Date(0),
    path: '/',
  });
}

export async function createMfaChallenge(
  platformAdminId: number,
  purpose: MfaChallengePurpose,
  totpSecret?: string,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const db = await getDb();
  const rawToken = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + MFA_CHALLENGE_TTL_MS);
  await db.getRepository<PlatformMfaChallengeEntity>('PlatformMfaChallenge').save({
    tokenHash: hashChallengeToken(rawToken),
    platformAdminId,
    purpose,
    totpSecretEncrypted: totpSecret ? encryptSecret(totpSecret) : null,
    expiresAt,
    consumedAt: null,
  });
  return { rawToken, expiresAt };
}

export async function loadValidMfaChallenge(
  rawToken: string | undefined | null,
  purpose?: MfaChallengePurpose,
): Promise<PlatformMfaChallengeEntity | null> {
  if (!rawToken || !/^[a-f0-9]{64}$/.test(rawToken)) return null;
  const db = await getDb();
  const challenge = await db.getRepository<PlatformMfaChallengeEntity>('PlatformMfaChallenge').findOneBy({
    tokenHash: hashChallengeToken(rawToken),
  });
  if (!challenge || challenge.consumedAt) return null;
  if (new Date(challenge.expiresAt).getTime() <= Date.now()) return null;
  if (purpose && challenge.purpose !== purpose) return null;
  return challenge;
}

export async function consumeMfaChallenge(tokenHash: string): Promise<void> {
  const db = await getDb();
  await db.getRepository<PlatformMfaChallengeEntity>('PlatformMfaChallenge').update(
    { tokenHash, consumedAt: IsNull() },
    { consumedAt: new Date() },
  );
}

export function isPlatformMfaEnrolled(admin: Pick<PlatformAdminEntity, 'totpSecretEncrypted' | 'totpEnrolledAt'>): boolean {
  return Boolean(admin.totpSecretEncrypted && admin.totpEnrolledAt);
}

export async function beginEnrollmentSecret(challenge: PlatformMfaChallengeEntity, email: string) {
  const db = await getDb();
  const secret = challenge.totpSecretEncrypted
    ? decryptSecret(challenge.totpSecretEncrypted)
    : generateTotpSecret();
  if (!secret) return null;
  if (!challenge.totpSecretEncrypted) {
    challenge.totpSecretEncrypted = encryptSecret(secret);
    await db.getRepository<PlatformMfaChallengeEntity>('PlatformMfaChallenge').save(challenge);
  }
  return {
    secret,
    otpauthUrl: totpOtpauthUrl(secret, email),
  };
}

export async function verifyChallengeTotp(challenge: PlatformMfaChallengeEntity, token: string): Promise<boolean> {
  if (!challenge.totpSecretEncrypted) return false;
  const secret = decryptSecret(challenge.totpSecretEncrypted);
  if (!secret) return false;
  return verifyTotp(secret, token);
}

export async function verifyAdminTotp(admin: PlatformAdminEntity, token: string): Promise<boolean> {
  if (!admin.totpSecretEncrypted) return false;
  const secret = decryptSecret(admin.totpSecretEncrypted);
  if (!secret) return false;
  return verifyTotp(secret, token);
}

export async function enrollPlatformMfa(
  admin: PlatformAdminEntity,
  secret: string,
): Promise<{ recoveryCodes: string[] }> {
  const db = await getDb();
  const recoveryCodes = generateRecoveryCodes();
  admin.totpSecretEncrypted = encryptSecret(secret);
  admin.totpEnrolledAt = new Date();
  await db.getRepository<PlatformAdminEntity>('PlatformAdmin').save(admin);

  const repo = db.getRepository<PlatformMfaRecoveryCodeEntity>('PlatformMfaRecoveryCode');
  await repo.createQueryBuilder().delete().where('platformAdminId = :id', { id: admin.id }).execute();
  await repo.save(recoveryCodes.map((code) => ({
    platformAdminId: admin.id,
    codeHash: hashRecoveryCode(code),
    usedAt: null,
  })));
  return { recoveryCodes };
}

export async function consumeRecoveryCode(platformAdminId: number, code: string): Promise<boolean> {
  const db = await getDb();
  const repo = db.getRepository<PlatformMfaRecoveryCodeEntity>('PlatformMfaRecoveryCode');
  const unused = await repo.find({ where: { platformAdminId, usedAt: IsNull() } });
  const { recoveryCodesMatch } = await import('./mfa-recovery');
  for (const row of unused) {
    if (recoveryCodesMatch(code, row.codeHash)) {
      row.usedAt = new Date();
      await repo.save(row);
      return true;
    }
  }
  return false;
}
