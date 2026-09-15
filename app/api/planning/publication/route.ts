import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { getPlanningEventSnapshot, type PlanningEventType } from '@/lib/planning/event-store';
import {
  applyPlanningPublicationAction,
  type PlanningPublicationAction,
} from '@/lib/planning/publication-service';
import { PlanningValidationError } from '@/lib/planning/validation';
import { PlanningConcurrencyError } from '@/lib/planning/event-store';
import { setCurrentClubId } from '@/lib/auth/club-context';

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validAction(value: unknown): value is PlanningPublicationAction {
  return value === 'cancel' || value === 'reopen';
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    const eventType = body.eventType;
    const action = body.action;
    const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : '';

    if (!eventId || !validEventType(eventType) || !validAction(action)) {
      return NextResponse.json({ error: 'Action de publication invalide' }, { status: 400 });
    }

    const db = await getDb();
    const snapshot = await getPlanningEventSnapshot(db, eventType, eventId);
    if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });

    const planningStatus = await applyPlanningPublicationAction(db, auth.user, snapshot, action, reason);
    return NextResponse.json({ success: true, eventId, eventType, planningStatus });
  } catch (error) {
    if (error instanceof PlanningValidationError) {
      return NextResponse.json({ error: error.message, blockers: error.details }, { status: 409 });
    }
    if (error instanceof PlanningConcurrencyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logError('app.unhandled', 'Planning publication failed:', error);
    return NextResponse.json({ error: 'Impossible de modifier la publication du planning' }, { status: 500 });
  }
}
