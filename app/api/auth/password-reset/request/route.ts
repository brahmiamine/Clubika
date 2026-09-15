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
import {
  checkLoginRateLimit,
  hashBucketComponent,
  recordFailedLoginAttempt,
} from '@/lib/auth/login-rate-limit';
import { CanonicalPublicOriginError, requireCanonicalPublicOrigin } from '@/lib/auth/canonical-public-origin';

const RATE_LIMIT_ROUTE_KEY = 'password-reset-request';
const GENERIC_MESSAGE = 'Si ce compte existe, les instructions de réinitialisation ont été préparées.';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function deliverResetNotice(email: string): Promise<boolean> {
  const url = process.env.PASSWORD_RESET_WEBHOOK_URL?.trim()
    || process.env.NOTIFICATION_EMAIL_WEBHOOK_URL?.trim();
  if (!url) return false;

  const token = process.env.PASSWORD_RESET_WEBHOOK_TOKEN?.trim()
    || process.env.NOTIFICATION_EMAIL_WEBHOOK_TOKEN?.trim();

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        to: email,
        subject: 'Réinitialisation de votre mot de passe Clubika',
        text: 'Si vous avez demandé une réinitialisation, ouvrez Clubika et suivez les instructions reçues. Ce message ne contient aucun lien ni jeton.',
      }),
    });
    return response.ok;
  } catch (error) {
    console.error('Password reset delivery failed:', error);
    return false;
  }
}

export async function POST(request: NextRequest) {
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
        console.error('[auth] Réinitialisation refusée : APP_BASE_URL canonique manquant.');
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
      const delivered = await deliverResetNotice(user.email);
      if (!delivered) pendingUrls.push(resetUrl);
    }

    return genericResponse(pendingUrls);
  } catch (error) {
    console.error('Password reset request failed:', error);
    return genericResponse();
  }
}
