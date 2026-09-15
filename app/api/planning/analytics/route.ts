import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { buildPlanningAnalytics } from '@/lib/planning/analytics';
import { setCurrentClubId } from '@/lib/auth/club-context';

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
