import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireAuth } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { resolveCanonicalPublicOrigin } from '@/lib/auth/canonical-public-origin';
import { buildIcalFeedUrl } from '@/lib/planning/ical-link';

/** Flux volontaire pour récupérer l’URL iCal personnelle (issue #382) — hors `/api/auth/me`. */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'calendarExport');
  if (disabled) return disabled;

  const user = await db.getRepository<UserEntity>('User').findOneBy({
    id: auth.user.id,
    clubId: auth.user.clubId,
  });
  if (!user?.active) {
    return NextResponse.json({ error: 'Utilisateur introuvable' }, { status: 404 });
  }

  const origin = resolveCanonicalPublicOrigin() ?? (process.env.NODE_ENV === 'production' ? null : 'http://localhost:3000');
  if (!origin) {
    return NextResponse.json({ error: 'APP_BASE_URL est requis pour générer un lien iCal' }, { status: 503 });
  }
  return NextResponse.json({
    feedUrl: buildIcalFeedUrl(origin, user.icalToken),
  });
}
