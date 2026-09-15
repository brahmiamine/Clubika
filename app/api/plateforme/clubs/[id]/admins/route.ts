import { logError } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { IsNull, MoreThan } from 'typeorm';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ClubTenantEntity, InvitationEntity, UserEntity } from '@/lib/db/schemas';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { requireRecentPlatformMfa } from '@/lib/auth/recent-auth';
import { hashInvitationToken, newInvitationToken } from '@/lib/auth/invitation-tokens';
import { resolveCanonicalPublicOrigin } from '@/lib/auth/canonical-public-origin';
import { isDuplicateEntryError } from '@/lib/db/duplicate-entry';
import { recordPrivilegedAuthEvent } from '@/lib/auth/privileged-auth-journal';

function serializeAdmin(user: UserEntity) {
  return {
    id: user.id,
    email: user.email,
    nom: user.nom,
    active: user.active,
    createdAt: user.createdAt,
  };
}

function pendingInvitationEmailKey(clubId: string, email: string): string {
  return `${clubId}:${email.toLowerCase()}`;
}

async function listAdmins(clubId: string) {
  const db = await getDb();
  const repo = db.getRepository<UserEntity>('User');
  const users = await repo.find({ where: { clubId }, order: { nom: 'ASC' } });
  return users.filter((user) => user.accessRole === 'admin');
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const { id } = params instanceof Promise ? await params : params;
    const db = await getDb();
    const clubRepo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const club = await clubRepo.findOneBy({ id });
    if (!club) {
      return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
    }

    const admins = await listAdmins(id);
    return NextResponse.json({ admins: admins.map(serializeAdmin) });
  } catch (error) {
    logError('app.unhandled', 'Error listing club admins:', error);
    return NextResponse.json({ error: 'Impossible de charger les administrateurs' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;
  const stepUp = await requireRecentPlatformMfa(request, auth.admin);
  if ('error' in stepUp) return stepUp.error;

  try {
    const { id } = params instanceof Promise ? await params : params;
    const db = await getDb();
    const clubRepo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const club = await clubRepo.findOneBy({ id });
    if (!club) {
      return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
    }

    const body = await request.json() as { email?: unknown; password?: unknown; nom?: unknown };
    if (typeof body.password === 'string' && body.password.length > 0) {
      return NextResponse.json({
        error: 'La plateforme ne définit pas le mot de passe d\'un administrateur de club. Une invitation expirante est envoyée.',
      }, { status: 400 });
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const nom = typeof body.nom === 'string' ? body.nom.trim() : '';
    if (!email) {
      return NextResponse.json({ error: 'L\'email est requis' }, { status: 400 });
    }
    if (!nom) {
      return NextResponse.json({ error: 'Le nom est requis' }, { status: 400 });
    }

    const userRepo = db.getRepository<UserEntity>('User');
    if (await userRepo.findOneBy({ email, clubId: id })) {
      return NextResponse.json({ error: 'Cet email est déjà utilisé dans ce club' }, { status: 409 });
    }

    const invitationRepo = db.getRepository<InvitationEntity>('Invitation');
    const pendingEmailKey = pendingInvitationEmailKey(id, email);
    const duplicate = await invitationRepo.findOne({
      where: {
        pendingEmailKey,
        usedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
      },
    });
    if (duplicate) {
      return NextResponse.json({ error: 'Une invitation en attente existe déjà pour cet email dans ce club' }, { status: 409 });
    }

    const rawToken = newInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    try {
      await invitationRepo.save({
        id: hashInvitationToken(rawToken),
        clubId: id,
        email,
        pendingEmailKey,
        accessRole: 'admin',
        planningFunctions: [],
        personNom: nom,
        personType: null,
        personId: null,
        createdByUserId: null,
        createdByPlatformAdminId: auth.admin.id,
        expiresAt,
        usedAt: null,
        usedByUserId: null,
        createdAt: new Date(),
      });
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        return NextResponse.json({ error: 'Une invitation en attente existe déjà pour cet email dans ce club' }, { status: 409 });
      }
      throw error;
    }

    await recordPrivilegedAuthEvent(db, {
      action: 'platform-club-admin-invite',
      actorType: 'platform',
      actorId: auth.admin.id,
      clubId: id,
      email,
    });

    const path = `/inscription/${rawToken}`;
    const origin = resolveCanonicalPublicOrigin();
    const admins = await listAdmins(id);
    return NextResponse.json({
      success: true,
      admins: admins.map(serializeAdmin),
      invitationUrl: origin ? `${origin}${path}` : path,
    });
  } catch (error) {
    logError('app.unhandled', 'Error inviting club admin:', error);
    return NextResponse.json({ error: 'Impossible de créer l\'invitation administrateur' }, { status: 500 });
  }
}
