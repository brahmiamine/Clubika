import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { MatchAuditLogEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  // Historique d'audit : lecture réservée aux rôles d'écriture (issue #126).
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const matchId = resolvedParams.id;

    if (!matchId || matchId.trim() === '') {
      return NextResponse.json({ error: 'ID de match invalide' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
    const entries = await repo.find({
      // Isolation tenant : un admin ne lit que l'audit de son club (issue #126).
      where: { entityId: matchId, clubId: auth.user.clubId },
      order: { createdAt: 'DESC' },
    });

    return NextResponse.json({ entries });
  } catch (error) {
    logError('app.unhandled', 'Erreur GET audit log:', error);
    return NextResponse.json({ error: 'Erreur lors de la récupération de l\'historique' }, { status: 500 });
  }
}
