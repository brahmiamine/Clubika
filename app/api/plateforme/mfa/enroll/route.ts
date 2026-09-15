import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { PlatformAdminEntity } from '@/lib/db/schemas';
import { PLATFORM_MFA_PENDING_COOKIE_NAME } from '@/lib/auth/constants';
import {
  beginEnrollmentSecret,
  clearMfaPendingCookie,
  consumeMfaChallenge,
  enrollPlatformMfa,
  loadValidMfaChallenge,
  verifyChallengeTotp,
} from '@/lib/auth/platform-mfa';
import { createPlatformSession, PLATFORM_SESSION_COOKIE_NAME, revokeAllPlatformSessionsForAdmin } from '@/lib/auth/platform-session';
import { recordPrivilegedAuthEvent } from '@/lib/auth/privileged-auth-journal';

export async function GET(request: NextRequest) {
  try {
    const pending = request.cookies.get(PLATFORM_MFA_PENDING_COOKIE_NAME)?.value;
    const challenge = await loadValidMfaChallenge(pending, 'enroll');
    if (!challenge) {
      return NextResponse.json({ error: 'Inscription MFA expirée. Recommencez la connexion.' }, { status: 401 });
    }
    const db = await getDb();
    const admin = await db.getRepository<PlatformAdminEntity>('PlatformAdmin').findOneBy({
      id: challenge.platformAdminId,
    });
    if (!admin || !admin.active) {
      return NextResponse.json({ error: 'Inscription MFA expirée. Recommencez la connexion.' }, { status: 401 });
    }
    const enrollment = await beginEnrollmentSecret(challenge, admin.email);
    if (!enrollment) {
      return NextResponse.json({ error: 'Impossible de préparer le second facteur' }, { status: 500 });
    }
    return NextResponse.json({
      secret: enrollment.secret,
      otpauthUrl: enrollment.otpauthUrl,
    });
  } catch (error) {
    console.error('Platform MFA enroll begin failed:', error);
    return NextResponse.json({ error: 'Impossible de préparer le second facteur' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const pending = request.cookies.get(PLATFORM_MFA_PENDING_COOKIE_NAME)?.value;
    const challenge = await loadValidMfaChallenge(pending, 'enroll');
    if (!challenge) {
      return NextResponse.json({ error: 'Inscription MFA expirée. Recommencez la connexion.' }, { status: 401 });
    }

    const body = await request.json() as { totp?: unknown };
    const totp = typeof body.totp === 'string' ? body.totp : '';
    if (!await verifyChallengeTotp(challenge, totp)) {
      return NextResponse.json({ error: 'Code invalide' }, { status: 401 });
    }
    const secret = challenge.totpSecretEncrypted;
    if (!secret) {
      return NextResponse.json({ error: 'Inscription MFA incomplète' }, { status: 400 });
    }

    const db = await getDb();
    const admin = await db.getRepository<PlatformAdminEntity>('PlatformAdmin').findOneBy({
      id: challenge.platformAdminId,
    });
    if (!admin || !admin.active) {
      return NextResponse.json({ error: 'Inscription MFA expirée. Recommencez la connexion.' }, { status: 401 });
    }

    const { decryptSecret } = await import('@/lib/crypto/secret-box');
    const plaintextSecret = decryptSecret(secret);
    if (!plaintextSecret) {
      return NextResponse.json({ error: 'Impossible d\'activer le second facteur' }, { status: 500 });
    }

    const { recoveryCodes } = await enrollPlatformMfa(admin, plaintextSecret);
    await consumeMfaChallenge(challenge.tokenHash);
    await revokeAllPlatformSessionsForAdmin(admin.id);
    await recordPrivilegedAuthEvent(db, {
      action: 'platform-mfa-enroll',
      actorType: 'platform',
      actorId: admin.id,
      email: admin.email,
    });

    const { token, expiresAt } = await createPlatformSession(admin.id);
    const response = NextResponse.json({
      success: true,
      recoveryCodes,
    });
    response.cookies.set(PLATFORM_SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });
    clearMfaPendingCookie(response);
    return response;
  } catch (error) {
    console.error('Platform MFA enroll confirm failed:', error);
    return NextResponse.json({ error: 'Impossible d\'activer le second facteur' }, { status: 500 });
  }
}
