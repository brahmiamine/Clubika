import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { buildPlanningAnalytics } from '@/lib/planning/analytics';
import { setCurrentClubId } from '@/lib/auth/club-context';

/**
 * Statistiques agrégées du planning (issue #16 — « Minimiser les statistiques nominatives
 * du planning »). Réservé aux administrateurs du club courant (`WRITE_ROLES` = `['admin']`),
 * jamais aux autres rôles. La réponse ne porte que sur une fenêtre glissante bornée (voir
 * `analyzedPeriod`, cf. `app/lib/planning/analytics.ts`) et ne renvoie plus, par personne,
 * que le nombre d'affectations — les refus, présences et absences nominatifs ont été
 * retirés de l'API : ils n'étaient pas affichés côté client et n'étaient pas justifiés pour
 * l'objectif de couverture/équité poursuivi ici. Voir `buildPlanningAnalytics` pour le détail
 * de chaque indicateur conservé et sa finalité.
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    return NextResponse.json(await buildPlanningAnalytics(await getDb()));
  } catch (error) {
    logError('app.unhandled', 'Planning analytics failed:', error);
    return NextResponse.json({ error: 'Impossible de calculer les statistiques du planning' }, { status: 500 });
  }
}
