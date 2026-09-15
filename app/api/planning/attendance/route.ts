import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  type PlanningEventType,
  type PlanningRole,
} from '@/lib/planning/event-store';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { syncAssignmentStatesForRole } from '@/lib/planning/assignment-state-store';
import { assignmentStatus, eventEndTimestamp, markAttendance } from '@/lib/planning/p0-rules';
import type { AttendanceStatus } from '@/types/match';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { readAppSettings } from '@/lib/settings-store';
import { setCurrentClubId } from '@/lib/auth/club-context';

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validRole(value: unknown): value is PlanningRole {
  return value === 'arbitre' || value === 'encadrant' || value === 'accompagnateur';
}

function validAttendance(value: unknown): value is Exclude<AttendanceStatus, 'unknown'> {
  return value === 'present' || value === 'excused' || value === 'absent' || value === 'replaced';
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const eventType = body.eventType;
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    const role = body.role;
    const status = body.status;
    const personId = typeof body.personId === 'number' && Number.isFinite(body.personId) ? body.personId : null;
    const personNom = typeof body.personNom === 'string' ? body.personNom.trim().toLowerCase() : '';

    if (!eventId || !validEventType(eventType) || !validRole(role) || !validAttendance(status)) {
      return NextResponse.json({ error: 'Présence invalide' }, { status: 400 });
    }
    if (personId === null && !personNom) {
      return NextResponse.json({ error: 'Personne requise' }, { status: 400 });
    }

    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'attendanceTracking');
    if (disabled) return disabled;
    const published = await listPublishedPlanningEventSnapshots(db, auth.user.clubId);
    const structural = published?.find((item) => item.eventType === eventType && item.eventId === eventId);
    const snapshot = structural
      ? (await hydratePlanningAssignmentStates(db, [structural], auth.user.clubId))[0] ?? null
      : null;
    if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });

    const { timeZone } = await readAppSettings(db, auth.user.clubId);
    const eventEnd = eventEndTimestamp(snapshot.date, snapshot.time, snapshot.durationMinutes, timeZone);
    if (eventEnd === null || eventEnd > Date.now()) {
      return NextResponse.json(
        { error: 'La présence ne peut être enregistrée qu’après la fin de l’événement' },
        { status: 409 },
      );
    }

    let changed = false;
    let declinedMatch = false;
    const before = snapshot.assignments[role];
    const next = before.map((contact) => {
      const matches = personId !== null
        ? contact.personId === personId
        : contact.nom.trim().toLowerCase() === personNom;
      if (!matches) return contact;
      if (assignmentStatus(contact) === 'declined') {
        declinedMatch = true;
        return contact;
      }
      changed = true;
      return markAttendance(contact, status);
    });

    if (declinedMatch && !changed) {
      return NextResponse.json(
        { error: 'Une affectation refusée ne peut pas recevoir de statut de présence' },
        { status: 409 },
      );
    }
    if (!changed) {
      return NextResponse.json({ error: 'Affectation introuvable pour cette personne' }, { status: 404 });
    }

    const updated = next.find((contact, index) => contact !== before[index]);
    if (!updated) {
      return NextResponse.json({ error: 'Affectation introuvable pour cette personne' }, { status: 404 });
    }
    await syncAssignmentStatesForRole(db, eventType, eventId, role, [updated], auth.user.clubId);
    await logAuditEntry(db, {
      user: auth.user,
      entityType: 'PlanningAttendance',
      entityId: `${eventType}:${eventId}:${role}`,
      action: 'attendance',
      before: { contacts: before },
      after: { contacts: next, status },
    });

    return NextResponse.json({ success: true, status });
  } catch (error) {
    logError('app.unhandled', 'Attendance update failed:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer la présence' }, { status: 500 });
  }
}
