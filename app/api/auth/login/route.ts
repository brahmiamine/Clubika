import { NextRequest, NextResponse } from 'next/server';
import { In } from 'typeorm';
import { getDb } from '@/lib/db';
import { ClubTenantEntity, UserEntity } from '@/lib/db/schemas';
import { verifyPasswordAndMaybeRehash } from '@/lib/auth/password';
import { createSession, SESSION_COOKIE_NAME } from '@/lib/auth/session';
import { canEdit, normalizeAccessRole } from '@/lib/auth/roles';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import { getClientIp } from '@/lib/auth/client-ip';
import {
  checkLoginRateLimit,
  hashBucketComponent,
  recordFailedLoginAttempt,
  resetLoginRateLimit,
} from '@/lib/auth/login-rate-limit';

const GENERIC_ERROR = { error: 'Email ou mot de passe incorrect' };

function resolveUserClubId(user: UserEntity): string {
  return user.clubId || process.env.APP_CLUB_ID || 'afp';
}

function tooManyRequests(retryAfterSeconds: number) {
  return NextResponse.json(
    { error: 'Trop de tentatives. Réessayez plus tard.' },
    { status: 429, headers: { 'Retry-After': String(retryAfterSeconds) } },
  );
}

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    // Issue #274 : la limite par IP est vérifiée AVANT même de lire le corps de la
    // requête, pour qu'une IP bloquée ne puisse pas consommer de travail supplémentaire
    // (validation, requête base) en variant le contenu envoyé.
    const ip = getClientIp(request);
    const ipBucket = `login:ip:${hashBucketComponent(ip)}`;
    const ipLimit = await checkLoginRateLimit(db, ipBucket);
    if (ipLimit.limited) return tooManyRequests(ipLimit.retryAfterSeconds!);

    const body = await request.json();
    const { email, password, clubId: requestedClubId } = body ?? {};
    if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
      return NextResponse.json({ error: 'Email et mot de passe requis' }, { status: 400 });
    }
    const normalizedClubId = typeof requestedClubId === 'string' ? requestedClubId.trim() : '';

    const normalizedEmail = email.trim().toLowerCase();
    const identityBucket = `login:identity:${hashBucketComponent(normalizedEmail)}`;
    const identityLimit = await checkLoginRateLimit(db, identityBucket);
    if (identityLimit.limited) return tooManyRequests(identityLimit.retryAfterSeconds!);

    const repo = db.getRepository<UserEntity>('User');
    // L'email n'est plus unique que par club (issue #266) : plusieurs comptes peuvent
    // partager la même adresse dans des clubs différents. Le mot de passe désambiguïse
    // en temps normal ; si plusieurs comptes correspondent, un clubId explicite est requis
    // (issue #347).
    let candidates = await repo.find({ where: { email: normalizedEmail } });
    if (normalizedClubId) {
      candidates = candidates.filter((candidate) => resolveUserClubId(candidate) === normalizedClubId);
    }

    const fail = async () => {
      const [ipResult] = await Promise.all([
        recordFailedLoginAttempt(db, ipBucket),
        recordFailedLoginAttempt(db, identityBucket),
      ]);
      if (ipResult.limited) {
        console.warn(`[auth] Connexion : verrouillage par IP déclenché (${ip}, ${ipResult.retryAfterSeconds}s)`);
      }
      return NextResponse.json(GENERIC_ERROR, { status: 401 });
    };

    const passwordMatches: UserEntity[] = [];
    for (const candidate of candidates) {
      // Un profil sans accès (issue #204) n'a pas d'identifiants connus : même si
      // le hash technique venait à être deviné, il ne doit jamais ouvrir de session.
      if (!candidate.active || !hasAccountAccess(candidate)) continue;

      const candidateClubId = resolveUserClubId(candidate);
      if (!(await isClubTenantActive(db, candidateClubId))) continue;

      const verified = await verifyPasswordAndMaybeRehash(password, candidate.passwordHash);
      if (verified.ok && verified.newHash) {
        candidate.passwordHash = verified.newHash;
        await repo.save(candidate);
      }
      if (verified.ok) {
        passwordMatches.push(candidate);
      }
    }

    if (passwordMatches.length === 0) {
      return await fail();
    }

    if (passwordMatches.length > 1 && !normalizedClubId) {
      const clubIds = [...new Set(passwordMatches.map(resolveUserClubId))];
      const tenants = await db.getRepository<ClubTenantEntity>('ClubTenant').find({
        where: { id: In(clubIds) },
      });
      const tenantNameById = new Map(tenants.map((tenant) => [tenant.id, tenant.name]));
      return NextResponse.json({
        requiresClubSelection: true,
        clubs: clubIds.map((clubId) => ({
          clubId,
          clubName: tenantNameById.get(clubId) || clubId,
        })),
      }, { status: 409 });
    }

    const matchedUser = passwordMatches[0];
    if (!matchedUser) {
      return await fail();
    }

    await Promise.all([
      resetLoginRateLimit(db, ipBucket),
      resetLoginRateLimit(db, identityBucket),
    ]);

    const { token, expiresAt } = await createSession(matchedUser.id, {
      userAgent: request.headers.get('user-agent'),
      ipAddress: request.headers.get('x-forwarded-for'),
    });

    const redirectTo = canEdit(normalizeAccessRole(matchedUser.accessRole))
      ? '/club'
      : '/mon-planning';

    const response = NextResponse.json({ success: true, redirectTo });
    response.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });
    return response;
  } catch (error) {
    console.error('Error during login:', error);
    return NextResponse.json({ error: 'Une erreur est survenue' }, { status: 500 });
  }
}
