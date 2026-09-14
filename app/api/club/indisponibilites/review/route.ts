import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { normalizeIndisponibilites } from '@/lib/utils/officiel-availability';
import { applyIndispoReview } from '@/lib/indisponibilites/review';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  enqueueUserNotificationIntents,
  deliverEnqueuedNotifications,
} from '@/lib/notifications/service';

function parseDecision(value: unknown): 'accepted' | 'rejected' | null {
  return value === 'accepted' || value === 'rejected' ? value : null;
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  }

  const userId = typeof body.userId === 'number' ? body.userId : Number.parseInt(String(body.userId ?? ''), 10);
  const indisponibiliteId = typeof body.indisponibiliteId === 'string' ? body.indisponibiliteId.trim() : '';
  const decision = parseDecision(body.decision);
  const comment = typeof body.comment === 'string' ? body.comment : null;

  if (!Number.isInteger(userId) || userId <= 0 || !indisponibiliteId || !decision) {
    return NextResponse.json({ error: 'Décision invalide' }, { status: 400 });
  }
  if (decision === 'rejected' && !(comment ?? '').trim()) {
    return NextResponse.json({ error: 'Un motif est requis pour refuser' }, { status: 400 });
  }

  try {
    const db = await getDb();
    const result = await db.transaction(async (manager) => {
      const user = await manager
        .getRepository<UserEntity>('User')
        .createQueryBuilder('account')
        .setLock('pessimistic_write')
        .where('account.id = :id AND account.clubId = :clubId', { id: userId, clubId: auth.user.clubId })
        .getOne();
      if (!user) {
        return { kind: 'missing' as const };
      }

      const current = normalizeIndisponibilites(user.indisponibilites);
      const applied = applyIndispoReview(current, indisponibiliteId, decision, auth.user.id, comment);
      if (!applied.ok) {
        return { kind: 'apply' as const, applied };
      }
      if (!applied.idempotent) {
        user.indisponibilites = applied.items;
        await manager.getRepository<UserEntity>('User').save(user);
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'PlanningAvailability',
          entityId: `${user.id}:${applied.reviewed.id}`,
          action: decision === 'accepted' ? 'approve' : 'reject',
          before: { status: 'pending' },
          after: {
            status: applied.reviewed.status,
            reviewComment: applied.reviewed.reviewComment ?? null,
          },
        });
      }
      return { kind: 'ok' as const, owner: user, reviewed: applied.reviewed, idempotent: applied.idempotent };
    });

    if (result.kind === 'missing') {
      return NextResponse.json({ error: 'Utilisateur introuvable' }, { status: 404 });
    }
    if (result.kind === 'apply') {
      return NextResponse.json({ error: result.applied.error }, { status: result.applied.status });
    }

    if (!result.idempotent) {
      const title = decision === 'accepted' ? 'Indisponibilité acceptée' : 'Indisponibilité refusée';
      const message = decision === 'accepted'
        ? 'Un administrateur a accepté votre indisponibilité.'
        : `Un administrateur a refusé votre indisponibilité${result.reviewed.reviewComment ? ` : ${result.reviewed.reviewComment}` : '.'}`;
      const enqueued = await enqueueUserNotificationIntents(
        db,
        result.owner,
        {
          type: 'availability-reviewed',
          title,
          message,
          urgency: 'important',
          eventType: 'indisponibilite',
          eventId: result.reviewed.id,
        },
        `indispo-review:${result.owner.id}:${result.reviewed.id}:${decision}`,
      );
      await deliverEnqueuedNotifications(db, enqueued);
    }

    return NextResponse.json({
      success: true,
      idempotent: result.idempotent,
      indisponibilite: result.reviewed,
    });
  } catch (error) {
    logError('app.unhandled', 'Error reviewing club indisponibilite:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer la décision' }, { status: 500 });
  }
}
