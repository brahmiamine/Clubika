import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { PlatformAdminEntity } from '@/lib/db/schemas';
import { verifyPasswordAndMaybeRehash } from '@/lib/auth/password';
import {
  createPlatformSession,
  PLATFORM_SESSION_COOKIE_NAME,
} from '@/lib/auth/platform-session';
import { getClientIp } from '@/lib/auth/client-ip';
import {
  checkLoginRateLimit,
  hashBucketComponent,
  recordFailedLoginAttempt,
  resetLoginRateLimit,
} from '@/lib/auth/login-rate-limit';
import {
  clearMfaPendingCookie,
  consumeMfaChallenge,
  consumeRecoveryCode,
  createMfaChallenge,
  isPlatformMfaEnrolled,
  loadValidMfaChallenge,
  setMfaPendingCookie,
  verifyAdminTotp,
} from '@/lib/auth/platform-mfa';
import { PLATFORM_MFA_PENDING_COOKIE_NAME } from '@/lib/auth/constants';
import { recordPrivilegedAuthEvent } from '@/lib/auth/privileged-auth-journal';

const GENERIC_ERROR = { error: 'Email ou mot de passe incorrect' };

function tooManyRequests(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: 'Trop de tentatives. Réessayez plus tard.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

function attachPlatformSession(response: NextResponse, token: string, expiresAt: Date) {
  response.cookies.set(PLATFORM_SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
  clearMfaPendingCookie(response);
  return response;
}

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    const ip = getClientIp(request);
    const ipBucket = `platform-login:ip:${hashBucketComponent(ip)}`;
    const ipLimit = await checkLoginRateLimit(db, ipBucket);
    if (ipLimit.limited) return tooManyRequests(ipLimit.retryAfterSeconds!);

    const body = await request.json() as {
      email?: unknown;
      password?: unknown;
      totp?: unknown;
      recoveryCode?: unknown;
    };
    if (!body.email || typeof body.email !== 'string' || !body.password || typeof body.password !== 'string') {
      return NextResponse.json({ error: 'Email et mot de passe requis' }, { status: 400 });
    }

    const normalizedEmail = body.email.trim().toLowerCase();
    const identityBucket = `platform-login:identity:${hashBucketComponent(normalizedEmail)}`;
    const identityLimit = await checkLoginRateLimit(db, identityBucket);
    if (identityLimit.limited) return tooManyRequests(identityLimit.retryAfterSeconds!);

    const repo = db.getRepository<PlatformAdminEntity>('PlatformAdmin');
    const admin = await repo.findOneBy({ email: normalizedEmail });

    const fail = async () => {
      const [ipResult] = await Promise.all([
        recordFailedLoginAttempt(db, ipBucket),
        recordFailedLoginAttempt(db, identityBucket),
      ]);
      if (ipResult.limited) {
        console.warn(`[auth] Connexion plateforme : verrouillage par IP déclenché (${ipResult.retryAfterSeconds}s)`);
      }
      return NextResponse.json(GENERIC_ERROR, { status: 401 });
    };

    if (!admin || !admin.active) {
      return await fail();
    }

    const verified = await verifyPasswordAndMaybeRehash(body.password, admin.passwordHash);
    if (!verified.ok) {
      return await fail();
    }
    if (verified.newHash) {
      admin.passwordHash = verified.newHash;
      await repo.save(admin);
    }

    await Promise.all([
      resetLoginRateLimit(db, ipBucket),
      resetLoginRateLimit(db, identityBucket),
    ]);

    const totp = typeof body.totp === 'string' ? body.totp : '';
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : '';

    if (!isPlatformMfaEnrolled(admin)) {
      const { rawToken, expiresAt } = await createMfaChallenge(admin.id, 'enroll');
      const response = NextResponse.json({
        success: false,
        mfaEnrollmentRequired: true,
      });
      setMfaPendingCookie(response, rawToken, expiresAt);
      return response;
    }

    if (totp && await verifyAdminTotp(admin, totp)) {
      const { token, expiresAt } = await createPlatformSession(admin.id);
      return attachPlatformSession(NextResponse.json({ success: true }), token, expiresAt);
    }

    if (recoveryCode && await consumeRecoveryCode(admin.id, recoveryCode)) {
      await recordPrivilegedAuthEvent(db, {
        action: 'platform-mfa-recovery',
        actorType: 'platform',
        actorId: admin.id,
        email: admin.email,
      });
      const { token, expiresAt } = await createPlatformSession(admin.id);
      return attachPlatformSession(
        NextResponse.json({ success: true, mfaRecoveryUsed: true }),
        token,
        expiresAt,
      );
    }

    const { rawToken, expiresAt } = await createMfaChallenge(admin.id, 'login');
    const response = NextResponse.json({
      success: false,
      mfaRequired: true,
    });
    setMfaPendingCookie(response, rawToken, expiresAt);
    return response;
  } catch (error) {
    console.error('Error during platform login:', error);
    return NextResponse.json({ error: 'Une erreur est survenue' }, { status: 500 });
  }
}

/** Vérifie le TOTP (ou un code de récupération) après le mot de passe. */
export async function PUT(request: NextRequest) {
  try {
    const pending = request.cookies.get(PLATFORM_MFA_PENDING_COOKIE_NAME)?.value;
    const challenge = await loadValidMfaChallenge(pending, 'login');
    if (!challenge) {
      return NextResponse.json({ error: 'Session MFA expirée. Recommencez la connexion.' }, { status: 401 });
    }

    const body = await request.json() as { totp?: unknown; recoveryCode?: unknown };
    const db = await getDb();
    const admin = await db.getRepository<PlatformAdminEntity>('PlatformAdmin').findOneBy({
      id: challenge.platformAdminId,
    });
    if (!admin || !admin.active) {
      return NextResponse.json({ error: 'Session MFA expirée. Recommencez la connexion.' }, { status: 401 });
    }

    const totp = typeof body.totp === 'string' ? body.totp : '';
    const recoveryCode = typeof body.recoveryCode === 'string' ? body.recoveryCode : '';
    const totpOk = totp ? await verifyAdminTotp(admin, totp) : false;
    const recoveryOk = !totpOk && recoveryCode ? await consumeRecoveryCode(admin.id, recoveryCode) : false;
    if (!totpOk && !recoveryOk) {
      return NextResponse.json({ error: 'Code invalide' }, { status: 401 });
    }
    if (recoveryOk) {
      await recordPrivilegedAuthEvent(db, {
        action: 'platform-mfa-recovery',
        actorType: 'platform',
        actorId: admin.id,
        email: admin.email,
      });
    }

    await consumeMfaChallenge(challenge.tokenHash);
    const { token, expiresAt } = await createPlatformSession(admin.id);
    return attachPlatformSession(
      NextResponse.json({ success: true, mfaRecoveryUsed: recoveryOk || undefined }),
      token,
      expiresAt,
    );
  } catch (error) {
    console.error('Error during platform MFA verify:', error);
    return NextResponse.json({ error: 'Une erreur est survenue' }, { status: 500 });
  }
}
