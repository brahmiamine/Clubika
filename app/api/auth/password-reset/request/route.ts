import { logError } from '@/lib/observability/log';
import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { PasswordResetTokenEntity, UserEntity } from '@/lib/db/schemas';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import {
  capabilityTooManyRequests,
  checkCapabilityIpRateLimit,
  recordCapabilityIpAttempt,
} from '@/lib/auth/capability-rate-limit';
import { CanonicalPublicOriginError, requireCanonicalPublicOrigin } from '@/lib/auth/canonical-public-origin';
import {
  checkLoginRateLimit,
  hashBucketComponent,
  recordFailedLoginAttempt,
} from '@/lib/auth/login-rate-limit';
import { deliverPasswordResetLink } from '@/lib/auth/password-reset-delivery';

const RATE_LIMIT_ROUTE_KEY = 'password-reset-request';
const GENERIC_MESSAGE = 'Si ce compte existe, les instructions de réinitialisation ont été préparées.';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function POST(request: NextRequest) {
  // Réponse volontairement peu informative (ne révèle ni l'existence ni le nombre
  // de comptes) ; `resetUrl`/`resetUrls` n'apparaissent qu'en développement, comme
  // repli quand l'envoi SMTP n'est pas configuré.
  const genericResponse = (resetUrls: string[] = []) => NextResponse.json({
    success: true,
    message: GENERIC_MESSAGE,
    ...(process.env.NODE_ENV !== 'production' && resetUrls.length > 0
      ? { resetUrl: resetUrls[0], ...(resetUrls.length > 1 ? { resetUrls } : {}) }
      : {}),
  });

  try {
    const db = await getDb();
    const blocked = await checkCapabilityIpRateLimit(db, request, RATE_LIMIT_ROUTE_KEY);
    if (blocked) return blocked;

    const body = await request.json();
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) {
      return NextResponse.json({ error: 'Email requis' }, { status: 400 });
    }

    const accountBucket = `${RATE_LIMIT_ROUTE_KEY}:account:${hashBucketComponent(email)}`;
    const accountLimit = await checkLoginRateLimit(db, accountBucket);
    if (accountLimit.limited) return capabilityTooManyRequests(accountLimit.retryAfterSeconds!);

    await recordCapabilityIpAttempt(db, request, RATE_LIMIT_ROUTE_KEY);
    await recordFailedLoginAttempt(db, accountBucket);

    let origin: string;
    try {
      origin = requireCanonicalPublicOrigin();
    } catch (error) {
      if (error instanceof CanonicalPublicOriginError && process.env.NODE_ENV === 'production') {
        logError('app.unhandled', '[auth] Réinitialisation refusée : APP_BASE_URL canonique manquant.');
        return genericResponse();
      }
      if (error instanceof CanonicalPublicOriginError) {
        return genericResponse();
      }
      throw error;
    }

    const users = await db.getRepository<UserEntity>('User').find({ where: { email } });
    const eligibleUsers = users.filter((user) => user.active && hasAccountAccess(user));
    if (eligibleUsers.length === 0) return genericResponse();

    const repo = db.getRepository<PasswordResetTokenEntity>('PasswordResetToken');
    const pendingUrls: string[] = [];

    for (const user of eligibleUsers) {
      const latest = await repo.findOne({ where: { userId: user.id }, order: { createdAt: 'DESC' } });
      if (latest && Date.now() - new Date(latest.createdAt).getTime() < 5 * 60_000) {
        continue;
      }

      const rawToken = randomBytes(32).toString('hex');
      await repo.save({
        tokenHash: hashToken(rawToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        usedAt: null,
      });

      const resetUrl = `${origin}/reinitialiser/${rawToken}`;
      const delivered = await deliverPasswordResetLink(user.email, resetUrl, user.clubId);
      if (!delivered) pendingUrls.push(resetUrl);
    }

    return genericResponse(pendingUrls);
  } catch (error) {
    logError('app.unhandled', 'Password reset request failed:', error);
    return genericResponse();
  }
}
