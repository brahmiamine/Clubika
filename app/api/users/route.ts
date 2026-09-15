import { logError } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { hashPassword } from '@/lib/auth/password';
import { normalizeAccessRole, normalizePlanningFunctions } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';

function serializeUser(user: UserEntity) {
  return {
    id: user.id,
    email: user.email,
    nom: user.nom,
    accessRole: user.accessRole,
    planningFunctions: user.planningFunctions,
    active: user.active,
    telephone: user.telephone,
    // Issue #204 : un profil sans accès (jamais activé) n'est pas un compte actif.
    claimedAt: user.claimedAt,
    hasAccess: user.claimedAt != null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const users = await repo.find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    // ?sansAcces=1 : ne retourne que les profils de dirigeants non réclamés,
    // pour permettre à une invitation de cibler un profil existant (issue #204).
    const unclaimedOnly = new URL(request.url).searchParams.get('sansAcces') === '1';
    const visible = unclaimedOnly ? users.filter((user) => user.claimedAt == null) : users;
    return NextResponse.json({ users: visible.map(serializeUser) });
  } catch (error) {
    logError('app.unhandled', 'Error reading users from DB:', error);
    return NextResponse.json({ error: 'Failed to load users' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const { email, password, nom, telephone } = body;
    const accessRole = normalizeAccessRole(body.accessRole);
    const planningFunctions = normalizePlanningFunctions(body.planningFunctions);

    if (!email || typeof email !== 'string' || email.trim() === '') {
      return NextResponse.json({ error: 'L\'email est requis' }, { status: 400 });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return NextResponse.json({ error: 'Le mot de passe doit contenir au moins 8 caractères' }, { status: 400 });
    }
    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const normalizedEmail = email.trim().toLowerCase();
    // Unicité par club, et non globale (issue #266) : cette adresse peut déjà être
    // utilisée dans un autre club, seul le club courant doit être vérifié.
    if (await repo.findOneBy({ email: normalizedEmail, clubId: auth.user.clubId })) {
      return NextResponse.json({ error: 'Un utilisateur avec cet email existe déjà dans ce club' }, { status: 400 });
    }

    const passwordHash = await hashPassword(password);
    await repo.save({
      clubId: auth.user.clubId,
      email: normalizedEmail,
      passwordHash,
      nom: nom.trim(),
      accessRole,
      planningFunctions,
      active: true,
      // Compte créé directement par un administrateur : accès actif immédiat.
      claimedAt: new Date(),
      telephone: typeof telephone === 'string' && telephone.trim() ? telephone.trim() : null,
      icalToken: randomBytes(24).toString('hex'),
    });

    const users = await repo.find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    return NextResponse.json({ success: true, data: { users: users.map(serializeUser) } });
  } catch (error) {
    logError('app.unhandled', 'Error creating user in DB:', error);
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
  }
}
