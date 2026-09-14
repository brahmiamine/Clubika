import { logError } from '@/lib/observability/log';
import { IsNull, MoreThan } from 'typeorm';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { InvitationEntity, UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { isClubAccessRole, normalizePlanningFunctions } from '@/lib/auth/roles';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { hashInvitationToken, newInvitationToken } from '@/lib/auth/invitation-tokens';
import { isDuplicateEntryError } from '@/lib/db/duplicate-entry';
import { BodyValidator, parseJsonBody, RequestValidationError } from '@/lib/validation/request';

function pendingInvitationEmailKey(clubId: string, email: string | null): string | null {
  return email ? `${clubId}:${email.toLowerCase()}` : null;
}

/**
 * Résout le profil de dirigeant sans accès visé par l'invitation (issue #204).
 *
 * - `personId` identifie le profil sans ambiguïté (recommandé, homonymes) ;
 * - à défaut, `personNom` n'est retenu que s'il désigne exactement un profil sans
 *   accès du club : zéro correspondance laisse un simple libellé d'affichage,
 *   plusieurs correspondances sont refusées plutôt que de deviner.
 */
async function resolveTargetProfile(
  db: Awaited<ReturnType<typeof getDb>>,
  clubId: string,
  input: { personId?: unknown; personNom?: unknown },
): Promise<{ profile: UserEntity | null } | { error: NextResponse }> {
  const userRepo = db.getRepository<UserEntity>('User');

  if (input.personId !== undefined && input.personId !== null) {
    if (typeof input.personId !== 'number' || !Number.isFinite(input.personId)) {
      return { error: NextResponse.json({ error: 'Identifiant de profil invalide' }, { status: 400 }) };
    }
    const profile = await userRepo.findOneBy({ id: input.personId, clubId });
    if (!profile) {
      return { error: NextResponse.json({ error: 'Profil introuvable dans ce club' }, { status: 404 }) };
    }
    if (hasAccountAccess(profile)) {
      return { error: NextResponse.json({ error: 'Ce profil dispose déjà d\'un accès : inutile de l\'inviter' }, { status: 409 }) };
    }
    if (!profile.active) {
      return { error: NextResponse.json({ error: 'Ce profil est désactivé' }, { status: 400 }) };
    }
    return { profile };
  }

  const personNom = typeof input.personNom === 'string' ? input.personNom.trim() : '';
  if (!personNom) return { profile: null };

  const candidates = (await userRepo.find({ where: { clubId } }))
    .filter((user) => user.nom.trim().toLowerCase() === personNom.toLowerCase())
    .filter((user) => user.active)
    .filter((user) => !hasAccountAccess(user));
  if (candidates.length > 1) {
    return {
      error: NextResponse.json(
        { error: 'Plusieurs profils sans accès portent ce nom : ciblez le profil par son identifiant' },
        { status: 400 },
      ),
    };
  }
  return { profile: candidates[0] ?? null };
}

function serializeInvitation(invitation: InvitationEntity) {
  return {
    id: invitation.id,
    email: invitation.email,
    accessRole: invitation.accessRole,
    planningFunctions: invitation.planningFunctions,
    personNom: invitation.personNom,
    personType: invitation.personType,
    personId: invitation.personId,
    expiresAt: invitation.expiresAt,
    usedAt: invitation.usedAt,
    createdAt: invitation.createdAt,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const repo = db.getRepository<InvitationEntity>('Invitation');
    const invitations = await repo.find({
      where: { clubId: auth.user.clubId },
      order: { createdAt: 'DESC' },
    });
    return NextResponse.json({ invitations: invitations.map(serializeInvitation) });
  } catch (error) {
    logError('app.unhandled', 'Error reading invitations from DB:', error);
    return NextResponse.json({ error: 'Failed to load invitations' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = parseJsonBody(await request.json());
    const v = new BodyValidator(body);
    v.forbidUnknownFields(['email', 'accessRole', 'personNom', 'personId', 'expiresInDays', 'planningFunctions']);
    const accessRole = v.enum('accessRole', ['admin', 'dirigeant']);
    const normalizedEmail = v.string('email', { required: false, maxLength: 255 })?.toLowerCase() ?? null;
    const personNom = v.string('personNom', { required: false, maxLength: 255 });
    const personId = v.number('personId', { required: false, min: 1 });
    const expiresInDays = v.number('expiresInDays', { required: false, min: 1, max: 365 });
    v.throwIfInvalid();

    if (!isClubAccessRole(accessRole)) {
      return NextResponse.json(
        { error: 'Rôle d\'accès invalide' },
        { status: 400 },
      );
    }

    // Une invitation administrateur non liée à un email pourrait être utilisée par
    // n'importe qui pour créer ou promouvoir plusieurs comptes admin (issue #271).
    if (accessRole === 'admin' && !normalizedEmail) {
      return NextResponse.json(
        { error: 'Une invitation administrateur doit être liée à une adresse email' },
        { status: 400 },
      );
    }

    const db = await getDb();
    const repo = db.getRepository<InvitationEntity>('Invitation');

    if (normalizedEmail) {
      const pendingEmailKey = pendingInvitationEmailKey(auth.user.clubId, normalizedEmail)!;
      const duplicate = await repo.findOne({
        where: {
          pendingEmailKey,
          usedAt: IsNull(),
          expiresAt: MoreThan(new Date()),
        },
      });
      if (duplicate) {
        return NextResponse.json(
          { error: 'Une invitation en attente existe déjà pour cet email dans ce club' },
          { status: 409 },
        );
      }
    }

    // Ciblage éventuel d'un profil de dirigeant sans accès existant (issue #204) :
    // l'acceptation activera ce profil au lieu de créer un second utilisateur.
    const resolved = await resolveTargetProfile(db, auth.user.clubId, { personId, personNom });
    if ('error' in resolved) return resolved.error;
    const targetProfile = resolved.profile;

    if (targetProfile) {
      const pending = await repo.findOne({
        where: {
          clubId: auth.user.clubId,
          personId: targetProfile.id,
          usedAt: IsNull(),
          expiresAt: MoreThan(new Date()),
        },
      });
      if (pending) {
        return NextResponse.json(
          { error: 'Une invitation en attente cible déjà ce profil' },
          { status: 409 },
        );
      }
    }

    // Un administrateur ne se voit pas imposer de fonction terrain par l'invitation :
    // seules les fonctions d'un dirigeant sont proposées à l'inscription.
    // Pour un profil ciblé, les fonctions de l'invitation s'ajoutent aux siennes à
    // l'activation ; par défaut on reprend simplement les fonctions du profil.
    const requestedFunctions = normalizePlanningFunctions(body.planningFunctions);
    const planningFunctions = targetProfile && requestedFunctions.length === 0
      ? normalizePlanningFunctions(targetProfile.planningFunctions)
      : requestedFunctions;

    const days = expiresInDays && expiresInDays > 0 ? expiresInDays : 7;
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const rawToken = newInvitationToken();
    const invitation: InvitationEntity = {
      id: hashInvitationToken(rawToken),
      clubId: auth.user.clubId,
      email: normalizedEmail,
      pendingEmailKey: pendingInvitationEmailKey(auth.user.clubId, normalizedEmail),
      accessRole,
      planningFunctions,
      personNom: targetProfile?.nom
        ?? personNom
        ?? null,
      personType: targetProfile ? 'user' : null,
      personId: targetProfile?.id ?? null,
      createdByUserId: auth.user.id,
      expiresAt,
      usedAt: null,
      usedByUserId: null,
      createdAt: new Date(),
    };

    await repo.save(invitation);

    return NextResponse.json({
      success: true,
      invitation: serializeInvitation(invitation),
      url: `/inscription/${rawToken}`,
    });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    if (isDuplicateEntryError(error)) {
      return NextResponse.json(
        { error: 'Une invitation en attente existe déjà pour cet email dans ce club' },
        { status: 409 },
      );
    }
    logError('app.unhandled', 'Error creating invitation in DB:', error);
    return NextResponse.json({ error: 'Failed to create invitation' }, { status: 500 });
  }
}
