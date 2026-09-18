import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireAuth } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { resolveCanonicalPublicOrigin } from '@/lib/auth/canonical-public-origin';
import { buildIcalFeedUrl } from '@/lib/planning/ical-link';
import { issueIcalToken, REVOKED_ICAL_TOKEN } from '@/lib/planning/ical-token';

interface LoadTargetUserResult {
  error?: NextResponse;
  repo: ReturnType<Awaited<ReturnType<typeof getDb>>['getRepository']>;
  user: UserEntity;
}

async function loadTargetUser(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<{ error: NextResponse } | Pick<LoadTargetUserResult, 'repo' | 'user'>> {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return { error: auth.error };
  }
  setCurrentClubId(auth.user.clubId);

  const resolvedParams = params instanceof Promise ? await params : params;
  const id = Number.parseInt(resolvedParams.id, 10);
  if (!Number.isFinite(id)) {
    return { error: NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 }) };
  }

  if (auth.user.accessRole !== 'admin' && auth.user.id !== id) {
    return { error: NextResponse.json({ error: 'Action non autorisée' }, { status: 403 }) };
  }

  const db = await getDb();
  const repo = db.getRepository<UserEntity>('User');
  const user = await repo.findOneBy({ id, clubId: auth.user.clubId });
  if (!user) {
    return { error: NextResponse.json({ error: 'Utilisateur non trouvé' }, { status: 404 }) };
  }

  return { repo, user };
}

/**
 * Régénère le jeton iCal personnel (issue #13) : l'ancien jeton — et toute URL
 * qui le porte — est immédiatement invalidé. Le jeton brut n'est renvoyé
 * qu'ici, une seule fois : seule son empreinte est persistée (migration `0041`).
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
): Promise<NextResponse> {
  const loaded = await loadTargetUser(request, context);
  if ('error' in loaded) return loaded.error;
  const { repo, user } = loaded;

  try {
    const issued = issueIcalToken();
    user.icalTokenHash = issued.icalTokenHash;
    user.icalTokenCreatedAt = issued.icalTokenCreatedAt;
    await repo.save(user);

    const origin = resolveCanonicalPublicOrigin() ?? (process.env.NODE_ENV === 'production' ? null : 'http://localhost:3000');
    if (!origin) {
      return NextResponse.json({ error: 'APP_BASE_URL est requis pour générer un lien iCal' }, { status: 503 });
    }
    return NextResponse.json({
      success: true,
      feedUrl: buildIcalFeedUrl(origin, issued.token),
      createdAt: issued.icalTokenCreatedAt,
    });
  } catch (error) {
    logError('app.unhandled', 'Error regenerating ical token:', error);
    return NextResponse.json({ error: 'Failed to regenerate token' }, { status: 500 });
  }
}

/**
 * Révoque le jeton iCal personnel (issue #13) sans en émettre un nouveau : le
 * flux `/api/ical/[token]` renvoie 404 pour l'ancienne URL jusqu'à une
 * régénération explicite.
 */
export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
): Promise<NextResponse> {
  const loaded = await loadTargetUser(request, context);
  if ('error' in loaded) return loaded.error;
  const { repo, user } = loaded;

  try {
    user.icalTokenHash = REVOKED_ICAL_TOKEN.icalTokenHash;
    user.icalTokenCreatedAt = REVOKED_ICAL_TOKEN.icalTokenCreatedAt;
    await repo.save(user);
    return NextResponse.json({ success: true, hasToken: false, createdAt: null });
  } catch (error) {
    logError('app.unhandled', 'Error revoking ical token:', error);
    return NextResponse.json({ error: 'Failed to revoke token' }, { status: 500 });
  }
}
