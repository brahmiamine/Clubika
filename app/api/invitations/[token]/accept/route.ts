import { logError } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { IsNull, type EntityManager } from 'typeorm';
import { getDb } from '@/lib/db';
import { InvitationEntity, UserEntity } from '@/lib/db/schemas';
import { hashPassword } from '@/lib/auth/password';
import { hashInvitationToken } from '@/lib/auth/invitation-tokens';
import {
  ALL_PLANNING_FUNCTIONS,
  canEdit,
  isClubAccessRole,
  normalizePlanningFunctions,
} from '@/lib/auth/roles';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import {
  checkCapabilityIpRateLimit,
  checkCapabilityTokenRateLimit,
  recordCapabilityIpAttempt,
  recordCapabilityTokenAttempt,
} from '@/lib/auth/capability-rate-limit';

const RATE_LIMIT_ROUTE_KEY = 'invitation-accept';

/** Erreur porteuse du statut HTTP à renvoyer, levée depuis la transaction (issue #271). */
class InvitationAcceptError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

async function acceptInvitationInTransaction(
  manager: EntityManager,
  tokenHash: string,
  input: { normalizedEmail: string; password: string; nom: string },
): Promise<{ user: UserEntity; redirectTo: string }> {
  const invitationRepo = manager.getRepository<InvitationEntity>('Invitation');
  const userRepo = manager.getRepository<UserEntity>('User');

  // Verrou pessimiste sur la ligne d'invitation : deux requêtes concurrentes sur le
  // même jeton se sérialisent ici, la seconde ne voit le `usedAt` posé par la
  // première qu'une fois sa transaction validée (issue #271).
  const invitation = await invitationRepo
    .createQueryBuilder('invitation')
    .setLock('pessimistic_write')
    .where('invitation.id = :id', { id: tokenHash })
    .getOne();

  if (!invitation) throw new InvitationAcceptError(404, 'Lien d\'invitation introuvable');
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
    throw new InvitationAcceptError(400, 'Cette invitation est réservée à une autre adresse email');
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
      icalToken: randomBytes(24).toString('hex'),
    });
  }

  // Consommation atomique et conditionnelle, en plus du verrou pessimiste ci-dessus
  // (défense en profondeur) : si la ligne a été marquée utilisée entre-temps par un
  // autre chemin, l'update n'affecte aucune ligne et la transaction est annulée.
  const consumed = await invitationRepo.update(
    { id: tokenHash, usedAt: IsNull() },
    { usedAt: claimedAt, usedByUserId: user.id, pendingEmailKey: null },
  );
  if (consumed.affected !== 1) {
    throw new InvitationAcceptError(409, 'Ce lien a déjà été utilisé');
  }

  return { user, redirectTo: canEdit(invitation.accessRole) ? '/club' : '/mon-planning' };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } }
) {
  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const token = resolvedParams.token;
    const db = await getDb();
    const ipBlocked = await checkCapabilityIpRateLimit(db, request, RATE_LIMIT_ROUTE_KEY);
    if (ipBlocked) return ipBlocked;
    const tokenBlocked = await checkCapabilityTokenRateLimit(db, RATE_LIMIT_ROUTE_KEY, token);
    if (tokenBlocked) return tokenBlocked;

    const body = await request.json();
    const { email, password, nom } = body;

    if (!email || typeof email !== 'string' || email.trim() === '') {
      return NextResponse.json({ error: 'L\'email est requis' }, { status: 400 });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Le mot de passe doit contenir au moins 8 caractères' }, { status: 400 });
    }
    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom est requis' }, { status: 400 });
    }

    const tokenHash = hashInvitationToken(token);
    const { user, redirectTo } = await db.transaction((manager) => acceptInvitationInTransaction(manager, tokenHash, {
      normalizedEmail: email.trim().toLowerCase(),
      password,
      nom: nom.trim(),
    }));

    const { token: sessionToken, expiresAt } = await createSession(user.id, {
      userAgent: request.headers.get('user-agent'),
      ipAddress: request.headers.get('x-forwarded-for'),
    });

    const response = NextResponse.json({ success: true, redirectTo });
    response.cookies.set(SESSION_COOKIE_NAME, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });
    return response;
  } catch (error) {
    if (error instanceof InvitationAcceptError) {
      if (error.status === 404 || error.status === 409 || error.status === 410) {
        const db = await getDb();
        const resolvedParams = params instanceof Promise ? await params : params;
        const token = resolvedParams.token;
        await recordCapabilityTokenAttempt(db, RATE_LIMIT_ROUTE_KEY, token);
        await recordCapabilityIpAttempt(db, request, RATE_LIMIT_ROUTE_KEY);
      }
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    logError('app.unhandled', 'Error accepting invitation:', error);
    return NextResponse.json({ error: 'Une erreur est survenue' }, { status: 500 });
  }
}
