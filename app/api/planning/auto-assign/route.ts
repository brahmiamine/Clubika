import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  getPlanningEventSnapshot,
  saveRoleAssignments,
  type PlanningEventType,
  type PlanningRole,
} from '@/lib/planning/event-store';
import { buildAssignmentSuggestions } from '@/lib/planning/assignment-suggestions';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { propagateAssignmentChangesIfPublished } from '@/lib/planning/assignment-propagation';
import { hasCoveredRole } from '@/lib/planning/p0-rules';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { PlanningValidationError } from '@/lib/planning/validation';

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validRole(value: unknown): value is PlanningRole {
  return value === 'arbitre' || value === 'encadrant' || value === 'accompagnateur';
}

function personTypeForRole(role: PlanningRole) {
  if (role === 'arbitre') return 'officiel' as const;
  if (role === 'encadrant') return 'encadrant' as const;
  return 'accompagnateur' as const;
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
    const requestedPersonId = typeof body.personId === 'number' && Number.isFinite(body.personId)
      ? body.personId
      : null;
    const force = body.force === true;

    if (!eventId || !validEventType(eventType) || !validRole(role)) {
      return NextResponse.json({ error: 'Demande d’affectation invalide' }, { status: 400 });
    }

    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'autoAssignment');
    if (disabled) return disabled;
    const snapshot = await getPlanningEventSnapshot(db, eventType, eventId);
    if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });

    if (!force && hasCoveredRole(snapshot.assignments[role])) {
      return NextResponse.json(
        { error: 'Ce rôle est déjà couvert. Utilisez force=true pour ajouter une autre personne.' },
        { status: 409 },
      );
    }

    const suggestions = await buildAssignmentSuggestions(db, snapshot, role, 20);
    const selected = requestedPersonId === null
      ? suggestions[0]
      : suggestions.find((candidate) => candidate.personId === requestedPersonId);

    if (!selected) {
      return NextResponse.json(
        { error: 'Aucun candidat disponible et sans conflit pour cette affectation' },
        { status: 409 },
      );
    }

    const before = snapshot.assignments[role];
    const next = await enrichAssignmentContacts(
      db,
      auth.user.clubId,
      [
        ...before,
        {
          nom: selected.nom,
          numero: selected.telephone ?? '',
          personId: selected.personId,
          personType: personTypeForRole(role),
          status: 'pending',
          assignedAt: new Date().toISOString(),
        },
      ],
      personTypeForRole(role),
      before,
    );

    await saveRoleAssignments(db, snapshot, role, next);
    // Si l'événement est déjà publié, cette auto-affectation marque l'événement `modified`
    // et attend la prochaine publication globale comme toute affectation admin (issue #197) ;
    // sinon rien à signaler avant la première publication.
    await propagateAssignmentChangesIfPublished(db, auth.user.clubId, snapshot, before, next);
    await logAuditEntry(db, {
      user: auth.user,
      entityType: 'PlanningAssignment',
      entityId: `${eventType}:${eventId}:${role}`,
      action: 'auto-assign',
      before: { contacts: before },
      after: { contacts: next, score: selected.score },
    });

    return NextResponse.json({
      success: true,
      assigned: selected,
      role,
      eventId,
      eventType,
    });
  } catch (error) {
    if (error instanceof PlanningValidationError) {
      return NextResponse.json({ error: error.message, blockers: error.details }, { status: 409 });
    }
    logError('app.unhandled', 'Auto assignment failed:', error);
    return NextResponse.json({ error: 'Impossible d’effectuer l’affectation automatique' }, { status: 500 });
  }
}
