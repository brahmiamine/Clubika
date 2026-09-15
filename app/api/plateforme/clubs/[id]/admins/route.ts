import { logError } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ClubTenantEntity, UserEntity } from '@/lib/db/schemas';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { hashPassword } from '@/lib/auth/password';

function serializeAdmin(user: UserEntity) {
  return {
    id: user.id,
    email: user.email,
    nom: user.nom,
    active: user.active,
    createdAt: user.createdAt,
  };
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

  try {
    const { id } = params instanceof Promise ? await params : params;
    const db = await getDb();
    const clubRepo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const club = await clubRepo.findOneBy({ id });
    if (!club) {
      return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
    }

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

    const normalizedEmail = email.trim().toLowerCase();
    const userRepo = db.getRepository<UserEntity>('User');
    // Unicité par club, et non globale (issue #266) : la même personne peut déjà
    // administrer un autre club avec cette adresse, seul le club ciblé compte ici.
    if (await userRepo.findOneBy({ email: normalizedEmail, clubId: id })) {
      return NextResponse.json({ error: 'Cet email est déjà utilisé dans ce club' }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    try {
      await userRepo.save({
        clubId: id,
        email: normalizedEmail,
        passwordHash,
        nom: nom.trim(),
        // Modèle #209 : un administrateur de club créé par la plateforme porte le
        // rôle d'accès admin (et non l'ancien tableau `roles`), sans fonction.
        accessRole: 'admin',
        planningFunctions: [],
        active: true,
        claimedAt: new Date(),
        icalToken: randomBytes(24).toString('hex'),
      });
    } catch (error) {
      if (
        error && typeof error === 'object'
        && (('code' in error && (error as { code?: unknown }).code === 'ER_DUP_ENTRY')
          || ('errno' in error && (error as { errno?: unknown }).errno === 1062))
      ) {
        return NextResponse.json({ error: 'Cet email est déjà utilisé dans ce club' }, { status: 409 });
      }
      throw error;
    }

    const admins = await listAdmins(id);
    return NextResponse.json({ success: true, admins: admins.map(serializeAdmin) });
  } catch (error) {
    logError('app.unhandled', 'Error creating club admin:', error);
    return NextResponse.json({ error: 'Impossible de créer l\'administrateur' }, { status: 500 });
  }
}
