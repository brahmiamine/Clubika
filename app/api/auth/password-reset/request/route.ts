import { logError } from '@/lib/observability/log';
import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { PasswordResetTokenEntity, UserEntity } from '@/lib/db/schemas';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import {
  checkCapabilityIpRateLimit,
  recordCapabilityIpAttempt,
} from '@/lib/auth/capability-rate-limit';

const RATE_LIMIT_ROUTE_KEY = 'password-reset-request';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function deliverResetLink(email: string, resetUrl: string): Promise<boolean> {
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
        text: `Utilisez ce lien pour choisir un nouveau mot de passe : ${resetUrl}`,
        resetUrl,
      }),
    });
    return response.ok;
  } catch (error) {
    logError('app.unhandled', 'Password reset delivery failed:', error);
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Réponse volontairement peu informative (ne révèle ni l'existence ni le nombre
  // de comptes) ; `resetUrl`/`resetUrls` n'apparaissent qu'en développement, comme
  // repli quand l'envoi réel (webhook SMTP) n'est pas configuré.
  const genericResponse = (resetUrls: string[] = []) => NextResponse.json({
    success: true,
    message: 'Si ce compte existe, les instructions de réinitialisation ont été préparées.',
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

    await recordCapabilityIpAttempt(db, request, RATE_LIMIT_ROUTE_KEY);
    // Unicité par club, et non globale (issue #266) : cette adresse peut porter un
    // compte indépendant dans plusieurs clubs — chacun reçoit son propre jeton
    // (une réinitialisation ne doit jamais agir sur le mot de passe d'un autre
    // compte), sans révéler leur nombre en dehors du mode développement.
    const users = await db.getRepository<UserEntity>('User').find({ where: { email } });
    // Un profil sans accès (issue #204) ne peut pas être activé par cette voie :
    // seule une invitation ciblée rattache des identifiants à son profil.
    const eligibleUsers = users.filter((user) => user.active && hasAccountAccess(user));
    if (eligibleUsers.length === 0) return genericResponse();

    const repo = db.getRepository<PasswordResetTokenEntity>('PasswordResetToken');
    const baseUrl = process.env.APP_BASE_URL?.replace(/\/$/, '') || new URL(request.url).origin;
    const pendingUrls: string[] = [];

    for (const user of eligibleUsers) {
      const latest = await repo.findOne({ where: { userId: user.id }, order: { createdAt: 'DESC' } });
      if (latest && Date.now() - new Date(latest.createdAt).getTime() < 5 * 60_000) {
        // Déjà demandé récemment pour ce compte précis : on passe au suivant plutôt
        // que d'abandonner toute la requête, pour ne pas bloquer les autres comptes
        // éligibles de cette même adresse.
        continue;
      }

      const rawToken = randomBytes(32).toString('hex');
      await repo.save({
        tokenHash: hashToken(rawToken),
        userId: user.id,
        expiresAt: new Date(Date.now() + 30 * 60_000),
        usedAt: null,
      });

      const resetUrl = `${baseUrl}/reinitialiser/${rawToken}`;
      const delivered = await deliverResetLink(user.email, resetUrl);
      if (!delivered) pendingUrls.push(resetUrl);
    }

    return genericResponse(pendingUrls);
  } catch (error) {
    logError('app.unhandled', 'Password reset request failed:', error);
    return genericResponse();
  }
}
