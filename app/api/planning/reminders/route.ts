import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import {
  type PlanningEventType,
  type PlanningRole,
} from '@/lib/planning/event-store';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { sendManualAssignmentReminder } from '@/lib/planning/reminders';
import { logAuditEntry } from '@/lib/db/audit-log';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validRole(value: unknown): value is PlanningRole {
  return value === 'arbitre' || value === 'encadrant' || value === 'accompagnateur';
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const eventType = body.eventType;
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    const requestedRole = body.role;
    const personId = typeof body.personId === 'number' && Number.isFinite(body.personId)
      ? body.personId
      : null;

    if (!eventId || !validEventType(eventType) || (requestedRole !== undefined && !validRole(requestedRole))) {
      return NextResponse.json({ error: 'Demande de relance invalide' }, { status: 400 });
    }

    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'automaticReminders');
    if (disabled) return disabled;
    const published = await listPublishedPlanningEventSnapshots(db);
    const structural = published?.find((item) => item.eventType === eventType && item.eventId === eventId);
    const snapshot = structural
      ? (await hydratePlanningAssignmentStates(db, [structural], auth.user.clubId))[0] ?? null
      : null;
    if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });

    const roles: PlanningRole[] = validRole(requestedRole)
      ? [requestedRole]
      : snapshot.eventType === 'officiel' || snapshot.eventType === 'amical'
        ? ['arbitre', 'encadrant', 'accompagnateur']
        : ['encadrant'];

    let sent = 0;
    for (const role of roles) {
      sent += await sendManualAssignmentReminder(db, snapshot, role, personId);
    }

    if (sent === 0) {
      return NextResponse.json(
        { error: 'Aucune affectation en attente à relancer sur un événement publié' },
        { status: 409 },
      );
    }

    await logAuditEntry(db, {
      user: auth.user,
      entityType: 'PlanningReminder',
      entityId: `${eventType}:${eventId}:${validRole(requestedRole) ? requestedRole : 'all'}`,
      action: 'manual-reminder',
      before: null,
      after: { sent, personId, roles },
    });

    return NextResponse.json({ success: true, sent, roles });
  } catch (error) {
    logError('app.unhandled', 'Manual planning reminder failed:', error);
    return NextResponse.json({ error: 'Impossible d’envoyer la relance' }, { status: 500 });
  }
}
