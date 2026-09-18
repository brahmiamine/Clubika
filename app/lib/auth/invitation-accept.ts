import { NextRequest, NextResponse } from 'next/server';
import { IsNull, type EntityManager } from 'typeorm';
import { logError } from '@/lib/observability/log';
import { getDb } from '@/lib/db';
import { InvitationEntity, UserEntity } from '@/lib/db/schemas';
import { hashPassword } from '@/lib/auth/password';
import {
  hashInvitationContextToken,
  hashInvitationToken,
} from '@/lib/auth/invitation-tokens';
import {
  ALL_PLANNING_FUNCTIONS,
  canEdit,
  isClubAccessRole,
  normalizePlanningFunctions,
} from '@/lib/auth/roles';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { sessionCookieSetOptions } from '@/lib/auth/session-cookie';
import { getClientIp } from '@/lib/auth/client-ip';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import {
  checkCapabilityIpRateLimit,
  checkCapabilityTokenRateLimit,
  recordCapabilityIpAttempt,
  recordCapabilityTokenAttempt,
} from '@/lib/auth/capability-rate-limit';
import {
  clearInvitationContextCookie,
  findInvitationByContextHash,
  INVITATION_PUBLIC_HEADERS,
  readInvitationContextCookie,
} from '@/lib/auth/invitation-public';

export const INVITATION_ACCEPT_RATE_LIMIT_KEY = 'invitation-accept';

const ALLOWED_ACCEPT_REDIRECTS = new Set(['/club', '/mon-planning']);

/** Erreur porteuse du statut HTTP à renvoyer, levée depuis la transaction (issue #271). */
export class InvitationAcceptError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function safeAcceptRedirect(path: string): string {
  return ALLOWED_ACCEPT_REDIRECTS.has(path) ? path : '/mon-planning';
}

function acceptJson(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: INVITATION_PUBLIC_HEADERS });
}

export function parseInvitationAcceptInput(body: unknown): {
  normalizedEmail: string;
  password: string;
  nom: string;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvitationAcceptError(400, 'Requête invalide');
  }
  const record = body as Record<string, unknown>;
  const email = record.email;
  const password = record.password;
  const nom = record.nom;
  if (!email || typeof email !== 'string' || email.trim() === '') {
    throw new InvitationAcceptError(400, 'L\'email est requis');
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    throw new InvitationAcceptError(400, 'Le mot de passe doit contenir au moins 8 caractères');
  }
  if (!nom || typeof nom !== 'string' || nom.trim() === '') {
    throw new InvitationAcceptError(400, 'Le nom est requis');
  }
  if (record.confirmIdentity !== true) {
    throw new InvitationAcceptError(400, 'Confirmez que cette adresse et cette identité vous appartiennent');
  }
  if (record.acknowledgeNotice !== true) {
    throw new InvitationAcceptError(400, 'Confirmez avoir pris connaissance des informations communiquées par le club');
  }
  return {
    normalizedEmail: email.trim().toLowerCase(),
    password,
    nom: nom.trim(),
  };
}

async function resolveInvitationForAccept(
  manager: EntityManager,
  lookup: { tokenHash?: string; contextHash?: string },
): Promise<InvitationEntity> {
  const invitationRepo = manager.getRepository<InvitationEntity>('Invitation');

  if (lookup.tokenHash) {
    const invitation = await invitationRepo
      .createQueryBuilder('invitation')
      .setLock('pessimistic_write')
      .where('invitation.id = :id', { id: lookup.tokenHash })
      .getOne();
    if (!invitation) throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
    return invitation;
  }

  if (lookup.contextHash) {
    const byContext = await findInvitationByContextHash(manager, lookup.contextHash);
    if (!byContext) throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
    const contextFresh = byContext.validationContextExpiresAt
      && new Date(byContext.validationContextExpiresAt).getTime() > Date.now();
    if (!contextFresh) throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
    const invitation = await invitationRepo
      .createQueryBuilder('invitation')
      .setLock('pessimistic_write')
      .where('invitation.id = :id', { id: byContext.id })
      .getOne();
    if (!invitation) throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
    return invitation;
  }

  throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
}

export async function acceptInvitationInTransaction(
  manager: EntityManager,
  lookup: { tokenHash?: string; contextHash?: string },
  input: { normalizedEmail: string; password: string; nom: string },
): Promise<{ user: UserEntity; redirectTo: string }> {
  const invitationRepo = manager.getRepository<InvitationEntity>('Invitation');
  const userRepo = manager.getRepository<UserEntity>('User');

  const invitation = await resolveInvitationForAccept(manager, lookup);

  if (invitation.usedAt) throw new InvitationAcceptError(409, 'Ce lien a déjà été utilisé');
  if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
    throw new InvitationAcceptError(410, 'Ce lien a expiré');
  }
  if (!isClubAccessRole(invitation.accessRole)) {
    throw new InvitationAcceptError(400, 'Rôle d\'invitation invalide');
  }
  // Un club désactivé après l'envoi de l'invitation ne doit plus permettre la création
  // du compte (issue #213). Même message que le lien introuvable : ne pas révéler
  // l'existence ni l'état du club côté client.
  if (!(await isClubTenantActive(manager, invitation.clubId))) {
    throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
  }
  if (invitation.email && invitation.email !== input.normalizedEmail) {
    throw new InvitationAcceptError(400, 'Les informations saisies ne correspondent pas à cette invitation');
  }

  // Invitation ciblant un profil de dirigeant sans accès (issue #204) : on attache
  // les identifiants au profil existant — jamais de second utilisateur, afin de
  // conserver fonctions, affectations et historique rattachés à `users.id`.
  let existingProfile: UserEntity | null = null;
  if (invitation.personType === 'user' && invitation.personId != null) {
    existingProfile = await userRepo.findOneBy({ id: invitation.personId, clubId: invitation.clubId });
    if (!existingProfile) {
      throw new InvitationAcceptError(404, 'Le profil visé par cette invitation n\'existe plus');
    }
    if (hasAccountAccess(existingProfile)) {
      throw new InvitationAcceptError(409, 'Ce profil a déjà été activé');
    }
    if (!existingProfile.active) {
      throw new InvitationAcceptError(403, 'Ce profil a été désactivé : contactez un administrateur');
    }
  }

  // Unicité par club, et non globale (issue #266) : la même adresse peut déjà
  // porter un compte dans un autre club — seul le club ciblé par l'invitation
  // doit être vérifié.
  const emailOwner = await userRepo.findOneBy({ email: input.normalizedEmail, clubId: invitation.clubId });
  if (emailOwner && emailOwner.id !== existingProfile?.id) {
    throw new InvitationAcceptError(400, 'Un utilisateur avec cet email existe déjà dans ce club');
  }

  const passwordHash = await hashPassword(input.password);
  const claimedAt = new Date();
  let user: UserEntity;
  if (existingProfile) {
    existingProfile.email = input.normalizedEmail;
    existingProfile.passwordHash = passwordHash;
    existingProfile.nom = input.nom;
    existingProfile.accessRole = invitation.accessRole;
    // Les fonctions de l'invitation complètent celles du profil, sans jamais en
    // retirer : l'activation ne doit pas amputer le référentiel existant.
    const functions = new Set([
      ...normalizePlanningFunctions(existingProfile.planningFunctions),
      ...normalizePlanningFunctions(invitation.planningFunctions),
    ]);
    existingProfile.planningFunctions = ALL_PLANNING_FUNCTIONS.filter((fn) => functions.has(fn));
    existingProfile.claimedAt = claimedAt;
    user = await userRepo.save(existingProfile);
  } else {
    user = await userRepo.save({
      clubId: invitation.clubId,
      email: input.normalizedEmail,
      passwordHash,
      nom: input.nom,
      accessRole: invitation.accessRole,
      planningFunctions: normalizePlanningFunctions(invitation.planningFunctions),
      active: true,
      claimedAt,
      // Pas de flux iCal généré à l'activation (issue #13) — l'abonné en génère
      // un depuis son profil — voir `app/lib/planning/ical-token.ts`.
    });
  }

  // Consommation atomique et conditionnelle, en plus du verrou pessimiste ci-dessus
  // (défense en profondeur) : si la ligne a été marquée utilisée entre-temps par un
  // autre chemin, l'update n'affecte aucune ligne et la transaction est annulée.
  const consumed = await invitationRepo.update(
    { id: invitation.id, usedAt: IsNull() },
    {
      usedAt: claimedAt,
      usedByUserId: user.id,
      pendingEmailKey: null,
      validationContextHash: null,
      validationContextExpiresAt: null,
    },
  );
  if (consumed.affected !== 1) {
    throw new InvitationAcceptError(409, 'Ce lien a déjà été utilisé');
  }

  return { user, redirectTo: safeAcceptRedirect(canEdit(invitation.accessRole) ? '/club' : '/mon-planning') };
}

export async function handleInvitationAccept(
  request: NextRequest,
  urlToken: string | null,
): Promise<NextResponse> {
  const contextRaw = readInvitationContextCookie(request);
  const rateLimitToken = urlToken || contextRaw;
  try {
    const db = await getDb();
    const ipBlocked = await checkCapabilityIpRateLimit(db, request, INVITATION_ACCEPT_RATE_LIMIT_KEY);
    if (ipBlocked) return ipBlocked;
    if (rateLimitToken) {
      const tokenBlocked = await checkCapabilityTokenRateLimit(db, INVITATION_ACCEPT_RATE_LIMIT_KEY, rateLimitToken);
      if (tokenBlocked) return tokenBlocked;
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new InvitationAcceptError(400, 'Requête invalide');
    }
    const input = parseInvitationAcceptInput(body);
    const lookup = {
      tokenHash: urlToken ? hashInvitationToken(urlToken) : undefined,
      contextHash: contextRaw ? hashInvitationContextToken(contextRaw) : undefined,
    };
    if (!lookup.tokenHash && !lookup.contextHash) {
      throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
    }

    const { user, redirectTo } = await db.transaction((manager) => acceptInvitationInTransaction(manager, lookup, input));

    const { token: sessionToken, expiresAt } = await createSession(user.id, {
      userAgent: request.headers.get('user-agent'),
      ipAddress: getClientIp(request),
    });

    const response = acceptJson({ success: true, redirectTo }, 200);
    clearInvitationContextCookie(response);
    response.cookies.set(SESSION_COOKIE_NAME, sessionToken, sessionCookieSetOptions(expiresAt));
    return response;
  } catch (error) {
    if (error instanceof InvitationAcceptError) {
      if (error.status === 404 || error.status === 409 || error.status === 410) {
        const db = await getDb();
        if (rateLimitToken) {
          await recordCapabilityTokenAttempt(db, INVITATION_ACCEPT_RATE_LIMIT_KEY, rateLimitToken);
        }
        await recordCapabilityIpAttempt(db, request, INVITATION_ACCEPT_RATE_LIMIT_KEY);
      }
      return acceptJson({ error: error.message }, error.status);
    }
    logError('app.unhandled', 'Error accepting invitation');
    return acceptJson({ error: 'Une erreur est survenue' }, 500);
  }
}
