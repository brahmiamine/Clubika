import { NextResponse, type NextRequest } from 'next/server';
import type { DataSource, EntityManager } from 'typeorm';
import { logError } from '@/lib/observability/log';
import { INVITATION_CONTEXT_COOKIE } from '@/lib/auth/constants';
import {
  hashInvitationContextToken,
  hashInvitationToken,
  INVITATION_CONTEXT_TTL_MS,
  maskEmail,
  newInvitationContextToken,
  padToMinimumDuration,
} from '@/lib/auth/invitation-tokens';
import {
  checkCapabilityIpRateLimit,
  checkCapabilityTokenRateLimit,
  recordCapabilityIpAttempt,
  recordCapabilityTokenAttempt,
} from '@/lib/auth/capability-rate-limit';
import { getDb } from '@/lib/db';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import type { InvitationEntity } from '@/lib/db/schemas';
import { readAppSettings } from '@/lib/settings-store';
import { loadNoticeConfig } from '@/lib/non-account-contacts/meta';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/non-account-contacts/constants';

export const INVITATION_VALIDATE_RATE_LIMIT_KEY = 'invitation-validate';

/** Forme unique des échecs publics : aucun détail d'état (issue #34). */
export const INVITATION_PUBLIC_INVALID_BODY = { valid: false as const };

export const INVITATION_PUBLIC_HEADERS: HeadersInit = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

export interface InvitationPublicPayload {
  valid: true;
  emailMasked: string | null;
  clubName: string;
  notice: { version: string; text: string; disclaimer: string } | null;
}

export function invitationPublicJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: INVITATION_PUBLIC_HEADERS });
}

export function invitationPublicInvalid(): NextResponse {
  return invitationPublicJson(INVITATION_PUBLIC_INVALID_BODY, 404);
}

function isInvitationCurrentlyUsable(invitation: InvitationEntity, nowMs: number): boolean {
  if (invitation.usedAt) return false;
  if (new Date(invitation.expiresAt).getTime() <= nowMs) return false;
  return true;
}

function setInvitationContextCookie(response: NextResponse, rawToken: string, expiresAt: Date): void {
  response.cookies.set(INVITATION_CONTEXT_COOKIE, rawToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

export function clearInvitationContextCookie(response: NextResponse): void {
  response.cookies.set(INVITATION_CONTEXT_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: new Date(0),
    path: '/',
  });
}

export function readInvitationContextCookie(request: NextRequest): string | null {
  const value = request.cookies.get(INVITATION_CONTEXT_COOKIE)?.value?.trim();
  return value && /^[a-f0-9]{64}$/i.test(value) ? value.toLowerCase() : null;
}

async function toPublicPayload(
  db: DataSource,
  invitation: InvitationEntity,
): Promise<InvitationPublicPayload> {
  const settings = await readAppSettings(db, invitation.clubId);
  const clubName = settings.clubName.trim() || 'Club';
  const noticeConfig = await loadNoticeConfig(db, invitation.clubId);
  const notice = noticeConfig?.noticeVersion
    ? {
        version: noticeConfig.noticeVersion,
        text: noticeConfig.noticeText,
        disclaimer: PRIVACY_NO_LEGAL_PROMISE,
      }
    : null;
  return {
    valid: true,
    emailMasked: maskEmail(invitation.email),
    clubName,
    notice,
  };
}

async function rotateValidationContext(
  db: DataSource | EntityManager,
  invitationId: string,
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = newInvitationContextToken();
  const expiresAt = new Date(Date.now() + INVITATION_CONTEXT_TTL_MS);
  await db.getRepository<InvitationEntity>('Invitation').update(
    { id: invitationId },
    {
      validationContextHash: hashInvitationContextToken(rawToken),
      validationContextExpiresAt: expiresAt,
    },
  );
  return { rawToken, expiresAt };
}

async function rejectInvalidValidation(
  db: DataSource,
  request: NextRequest,
  capability: string,
): Promise<NextResponse> {
  await recordCapabilityTokenAttempt(db, INVITATION_VALIDATE_RATE_LIMIT_KEY, capability);
  await recordCapabilityIpAttempt(db, request, INVITATION_VALIDATE_RATE_LIMIT_KEY);
  const response = invitationPublicInvalid();
  clearInvitationContextCookie(response);
  return response;
}

/**
 * GET public d'un jeton d'URL : rate-limit, forme uniforme, payload minimal,
 * échange contre un cookie de contexte (issue #34).
 */
export async function validateInvitationFromUrlToken(
  request: NextRequest,
  rawToken: string,
): Promise<NextResponse> {
  const startedAtMs = Date.now();
  try {
    const db = await getDb();
    const ipBlocked = await checkCapabilityIpRateLimit(db, request, INVITATION_VALIDATE_RATE_LIMIT_KEY);
    if (ipBlocked) return ipBlocked;
    const tokenBlocked = await checkCapabilityTokenRateLimit(db, INVITATION_VALIDATE_RATE_LIMIT_KEY, rawToken);
    if (tokenBlocked) return tokenBlocked;

    const tokenHash = hashInvitationToken(rawToken);
    const invitation = await db.getRepository<InvitationEntity>('Invitation').findOneBy({ id: tokenHash });
    if (!invitation || !isInvitationCurrentlyUsable(invitation, Date.now())) {
      return rejectInvalidValidation(db, request, rawToken);
    }
    if (!(await isClubTenantActive(db, invitation.clubId))) {
      return rejectInvalidValidation(db, request, rawToken);
    }

    const payload = await toPublicPayload(db, invitation);
    const context = await rotateValidationContext(db, invitation.id);
    const response = invitationPublicJson(payload, 200);
    setInvitationContextCookie(response, context.rawToken, context.expiresAt);
    return response;
  } catch {
    logError('app.unhandled', 'Error validating invitation');
    return invitationPublicJson({ valid: false }, 500);
  } finally {
    await padToMinimumDuration(startedAtMs);
  }
}

/**
 * Relit le cookie de contexte après retrait du jeton d'URL (issue #34).
 * Ne fait pas tourner le contexte : un rafraîchissement de page ne doit pas
 * invalider l'échange.
 */
export async function validateInvitationFromContextCookie(request: NextRequest): Promise<NextResponse> {
  const startedAtMs = Date.now();
  try {
    const db = await getDb();
    const ipBlocked = await checkCapabilityIpRateLimit(db, request, INVITATION_VALIDATE_RATE_LIMIT_KEY);
    if (ipBlocked) return ipBlocked;

    const rawContext = readInvitationContextCookie(request);
    if (!rawContext) {
      await recordCapabilityIpAttempt(db, request, INVITATION_VALIDATE_RATE_LIMIT_KEY);
      return invitationPublicInvalid();
    }

    const tokenBlocked = await checkCapabilityTokenRateLimit(db, INVITATION_VALIDATE_RATE_LIMIT_KEY, rawContext);
    if (tokenBlocked) return tokenBlocked;

    const contextHash = hashInvitationContextToken(rawContext);
    const invitation = await db.getRepository<InvitationEntity>('Invitation').findOneBy({
      validationContextHash: contextHash,
    });
    const now = Date.now();
    const contextFresh = invitation?.validationContextExpiresAt
      && new Date(invitation.validationContextExpiresAt).getTime() > now;
    if (!invitation || !contextFresh || !isInvitationCurrentlyUsable(invitation, now)) {
      return rejectInvalidValidation(db, request, rawContext);
    }
    if (!(await isClubTenantActive(db, invitation.clubId))) {
      return rejectInvalidValidation(db, request, rawContext);
    }

    const payload = await toPublicPayload(db, invitation);
    return invitationPublicJson(payload, 200);
  } catch {
    logError('app.unhandled', 'Error validating invitation context');
    return invitationPublicJson({ valid: false }, 500);
  } finally {
    await padToMinimumDuration(startedAtMs);
  }
}

export async function findInvitationByContextHash(
  manager: DataSource | EntityManager,
  contextHash: string,
): Promise<InvitationEntity | null> {
  return manager.getRepository<InvitationEntity>('Invitation').findOneBy({
    validationContextHash: contextHash,
  });
}
