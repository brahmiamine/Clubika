import { NextRequest, NextResponse } from 'next/server';
import type { UserSessionEntity } from '@/lib/db/schemas';
import { getDb } from '@/lib/db';
import { getSessionUser, SESSION_COOKIE_NAME, findSessionByToken as findClubSessionByToken, type SessionUser } from './session';
import {
  getPlatformSessionAdmin,
  PLATFORM_SESSION_COOKIE_NAME,
  findSessionByToken as findPlatformSessionByToken,
  type PlatformAdminSessionUser,
} from './platform-session';
import { isPlausibleSessionToken } from './session-token';

export const STEP_UP_MAX_AGE_MS = 15 * 60 * 1000;
export const REAUTH_REQUIRED = 'REAUTH_REQUIRED';
export const MFA_STEP_UP_REQUIRED = 'MFA_STEP_UP_REQUIRED';

function tooOld(at: Date | null | undefined, maxAgeMs: number): boolean {
  if (!at) return true;
  return Date.now() - new Date(at).getTime() > maxAgeMs;
}

export function reauthRequiredResponse(message = 'Réauthentification requise pour cette action.'): NextResponse {
  return NextResponse.json({ error: message, code: REAUTH_REQUIRED }, { status: 401 });
}

export function mfaStepUpRequiredResponse(
  message = 'Un second facteur récent est requis pour cette action.',
): NextResponse {
  return NextResponse.json({ error: message, code: MFA_STEP_UP_REQUIRED }, { status: 401 });
}

export async function getClubSessionAuthenticatedAt(token: string | undefined | null): Promise<Date | null> {
  if (!isPlausibleSessionToken(token)) return null;
  const session = await findClubSessionByToken(token);
  if (!session || session.revokedAt) return null;
  return session.authenticatedAt ?? session.createdAt;
}

export async function requireRecentClubAuth(
  request: NextRequest,
  user: SessionUser,
  maxAgeMs = STEP_UP_MAX_AGE_MS,
): Promise<{ ok: true } | { error: NextResponse }> {
  void user;
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const authenticatedAt = await getClubSessionAuthenticatedAt(token);
  if (tooOld(authenticatedAt, maxAgeMs)) {
    return { error: reauthRequiredResponse() };
  }
  return { ok: true };
}

export async function touchClubSessionAuth(token: string | undefined | null): Promise<void> {
  if (!isPlausibleSessionToken(token)) return;
  const session = await findClubSessionByToken(token);
  if (!session || session.revokedAt) return;
  const db = await getDb();
  await db.getRepository<UserSessionEntity>('UserSession').update(
    { id: session.id },
    { authenticatedAt: new Date() },
  );
}

export async function getPlatformSessionMfaAt(token: string | undefined | null): Promise<Date | null> {
  if (!isPlausibleSessionToken(token)) return null;
  const session = await findPlatformSessionByToken(token);
  if (!session || session.revokedAt) return null;
  return session.mfaVerifiedAt ?? null;
}

export async function requireRecentPlatformMfa(
  request: NextRequest,
  admin: PlatformAdminSessionUser,
  maxAgeMs = STEP_UP_MAX_AGE_MS,
): Promise<{ ok: true } | { error: NextResponse }> {
  void admin;
  const token = request.cookies.get(PLATFORM_SESSION_COOKIE_NAME)?.value;
  const verifiedAt = await getPlatformSessionMfaAt(token);
  if (tooOld(verifiedAt, maxAgeMs)) {
    return { error: mfaStepUpRequiredResponse() };
  }
  return { ok: true };
}

export async function requireRecentClubAuthFromRequest(
  request: NextRequest,
): Promise<{ user: SessionUser } | { error: NextResponse }> {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const user = await getSessionUser(token);
  if (!user) {
    return { error: NextResponse.json({ error: 'Non authentifié' }, { status: 401 }) };
  }
  const recent = await requireRecentClubAuth(request, user);
  if ('error' in recent) return recent;
  return { user };
}

export async function getPlatformSessionAdminFromRequest(request: NextRequest) {
  const token = request.cookies.get(PLATFORM_SESSION_COOKIE_NAME)?.value;
  return getPlatformSessionAdmin(token);
}
