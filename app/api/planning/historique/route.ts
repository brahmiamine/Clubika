import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { buildReadableHistory } from '@/lib/planning/history';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const history = await buildReadableHistory(db, 100);
    return NextResponse.json({ history });
  } catch (error) {
    logError('app.unhandled', 'Error building readable history:', error);
    return NextResponse.json({ error: 'Impossible de charger l\'historique' }, { status: 500 });
  }
}
