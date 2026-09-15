import { logError } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireAuth } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { resolveCanonicalPublicOrigin } from '@/lib/auth/canonical-public-origin';
import { buildIcalFeedUrl } from '@/lib/planning/ical-link';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const id = Number.parseInt(resolvedParams.id, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 });
    }

    if (auth.user.accessRole !== 'admin' && auth.user.id !== id) {
      return NextResponse.json({ error: 'Action non autorisée' }, { status: 403 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const user = await repo.findOneBy({ id, clubId: auth.user.clubId });
    if (!user) {
      return NextResponse.json({ error: 'Utilisateur non trouvé' }, { status: 404 });
    }

    user.icalToken = randomBytes(24).toString('hex');
    await repo.save(user);

    const origin = resolveCanonicalPublicOrigin() ?? (process.env.NODE_ENV === 'production' ? null : 'http://localhost:3000');
    if (!origin) {
      return NextResponse.json({ error: 'APP_BASE_URL est requis pour générer un lien iCal' }, { status: 503 });
    }
    return NextResponse.json({
      success: true,
      feedUrl: buildIcalFeedUrl(origin, user.icalToken),
    });
  } catch (error) {
    logError('app.unhandled', 'Error regenerating ical token:', error);
    return NextResponse.json({ error: 'Failed to regenerate token' }, { status: 500 });
  }
}
