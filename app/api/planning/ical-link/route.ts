import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireAuth } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';

/**
 * État de l'abonnement iCal personnel (issue #382, durci par l'issue #13) —
 * hors `/api/auth/me`.
 *
 * Ne renvoie plus l'URL du flux : depuis la migration `0041`, seule l'empreinte
 * du jeton est stockée, le jeton brut n'est donc plus récupérable après coup.
 * Il n'est restitué qu'une fois, à sa génération — voir
 * `POST /api/users/[id]/regenerate-ical-token`. Cette route ne renvoie que des
 * métadonnées (date de création, présence d'un flux actif) pour permettre à
 * l'abonné de gérer son flux (voir, révoquer, régénérer) sans jamais réexposer
 * le secret.
 */
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

  return NextResponse.json({
    hasToken: Boolean(user.icalTokenHash),
    createdAt: user.icalTokenCreatedAt,
  });
}
