import { logError, logWarn } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { PlatformAdminEntity } from '@/lib/db/schemas';
import { verifyPassword } from '@/lib/auth/password';
import { createPlatformSession, PLATFORM_SESSION_COOKIE_NAME } from '@/lib/auth/platform-session';
import { getClientIp } from '@/lib/auth/client-ip';
import {
  checkLoginRateLimit,
  hashBucketComponent,
  recordFailedLoginAttempt,
  resetLoginRateLimit,
} from '@/lib/auth/login-rate-limit';

const GENERIC_ERROR = { error: 'Email ou mot de passe incorrect' };

function tooManyRequests(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: 'Trop de tentatives. Réessayez plus tard.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    // Issue #274 : accès administrateur de plateforme, à fort impact — mêmes garde-fous
    // que la connexion club, dans des buckets distincts (`platform-login:` plutôt que
    // `login:`) pour ne jamais partager de compteur avec les comptes de club.
    const ip = getClientIp(request);
    const ipBucket = `platform-login:ip:${hashBucketComponent(ip)}`;
    const ipLimit = await checkLoginRateLimit(db, ipBucket);
    if (ipLimit.limited) return tooManyRequests(ipLimit.retryAfterSeconds!);

    const { email, password } = await request.json();
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Email et mot de passe requis' }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();
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
        logWarn('auth.failed');
      }
      return NextResponse.json(GENERIC_ERROR, { status: 401 });
    };

    if (!admin || !admin.active) {
      return await fail();
    }

    const isValid = await verifyPassword(password, admin.passwordHash);
    if (!isValid) {
      return await fail();
    }

    await Promise.all([
      resetLoginRateLimit(db, ipBucket),
      resetLoginRateLimit(db, identityBucket),
    ]);

    const { token, expiresAt } = await createPlatformSession(admin.id, {
      userAgent: request.headers.get('user-agent'),
      ipAddress: request.headers.get('x-forwarded-for'),
    });

    const response = NextResponse.json({ success: true });
    response.cookies.set(PLATFORM_SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });
    return response;
  } catch (error) {
    logError('auth.failed', error);
    return NextResponse.json({ error: 'Une erreur est survenue' }, { status: 500 });
  }
}
