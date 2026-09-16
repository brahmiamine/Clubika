import { logError } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { UNUSABLE_PASSWORD_HASH } from '@/lib/auth/password';
import { normalizeAccessRole, normalizePlanningFunctions } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { serializeManagedUser, wantsRevealedPhone } from '@/lib/non-account-contacts/serialize-user';

function serializeUser(user: UserEntity, revealPhone = false) {
  return serializeManagedUser(user, { revealPhone });
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const users = await repo.find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    const revealPhone = wantsRevealedPhone(request.url);
    const unclaimedOnly = new URL(request.url).searchParams.get('sansAcces') === '1';
    const visible = unclaimedOnly ? users.filter((user) => user.claimedAt == null) : users;
    return NextResponse.json({ users: visible.map((user) => serializeUser(user, revealPhone)) });
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

    if (typeof password === 'string' && password.length > 0) {
      return NextResponse.json({
        error: 'Un administrateur ne peut pas définir le mot de passe d\'un tiers. Envoyez une invitation.',
      }, { status: 400 });
    }
    if (!email || typeof email !== 'string' || email.trim() === '') {
      return NextResponse.json({ error: 'L\'email est requis' }, { status: 400 });
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

    const passwordHash = UNUSABLE_PASSWORD_HASH;
    await repo.save({
      clubId: auth.user.clubId,
      email: normalizedEmail,
      passwordHash,
      nom: nom.trim(),
      accessRole,
      planningFunctions,
      active: true,
      // Profil créé sans identifiants : la prise de contrôle passe par une invitation (issue #32).
      claimedAt: null,
      telephone: typeof telephone === 'string' && telephone.trim() ? telephone.trim() : null,
      icalToken: randomBytes(24).toString('hex'),
    });

    const users = await repo.find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    return NextResponse.json({ success: true, data: { users: users.map((user) => serializeUser(user)) } });
  } catch (error) {
    logError('app.unhandled', 'Error creating user in DB:', error);
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 });
  }
}
