import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import {
  getPlanningEventSnapshot,
  type PlanningEventType,
  type PlanningRole,
} from '@/lib/planning/event-store';
import { buildAssignmentSuggestions } from '@/lib/planning/assignment-suggestions';
import { needsReplacement } from '@/lib/planning/p0-rules';
import { setCurrentClubId } from '@/lib/auth/club-context';

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validRole(value: unknown): value is PlanningRole {
  return value === 'arbitre' || value === 'encadrant' || value === 'accompagnateur';
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const { searchParams } = new URL(request.url);
  const eventType = searchParams.get('eventType');
  const eventId = searchParams.get('eventId')?.trim() ?? '';
  const role = searchParams.get('role');
  const limitRaw = Number.parseInt(searchParams.get('limit') ?? '5', 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 5;

  if (!eventId || !validEventType(eventType) || !validRole(role)) {
    return NextResponse.json({ error: 'Paramètres de suggestion invalides' }, { status: 400 });
  }

  try {
    const db = await getDb();
    const snapshot = await getPlanningEventSnapshot(db, eventType, eventId);
    if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });

    const suggestions = await buildAssignmentSuggestions(db, snapshot, role, limit);
    return NextResponse.json({
      event: {
        eventId: snapshot.eventId,
        eventType: snapshot.eventType,
        title: snapshot.title,
        date: snapshot.date,
        time: snapshot.time,
        planningStatus: snapshot.planningStatus,
      },
      role,
      needsReplacement: needsReplacement(snapshot.assignments[role]),
      suggestions,
    });
  } catch (error) {
    logError('app.unhandled', 'Assignment suggestions failed:', error);
    return NextResponse.json({ error: 'Impossible de générer les suggestions' }, { status: 500 });
  }
}
