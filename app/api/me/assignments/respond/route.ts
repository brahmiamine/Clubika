import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { hasPlanningFunction, hasAnyPlanningFunction } from '@/lib/auth/roles';
import type { AssignmentContact, AssignmentStatus, DeclineReason } from '@/types/match';
import { functionForPlanningRole, personIdentityMatches } from '@/lib/planning/person-link';
import { notifyAdmins } from '@/lib/notifications/service';
import { logAuditEntry } from '@/lib/db/audit-log';
import type { PlanningEventType, PlanningRole } from '@/lib/planning/event-store';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { syncAssignmentStatesForRole } from '@/lib/planning/assignment-state-store';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { eventStartTimestamp, isResponseWindowClosed, isVisiblePublicationStatus } from '@/lib/planning/p0-rules';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';
import { vacateDeclinedAssignmentFromWorkingDraft } from '@/lib/planning/declined-assignment-draft';
import {
  assignmentDeclineNotificationSuffix,
  parseIncomingDeclineReason,
  redactAssignmentContactForAudit,
} from '@/lib/privacy/health-data';

function nextStatus(value: unknown): AssignmentStatus | null {
  return value === 'accepted' || value === 'declined' ? value : null;
}

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validRole(value: unknown): value is PlanningRole {
  return value === 'arbitre' || value === 'encadrant' || value === 'accompagnateur';
}

/**
 * Construit le nouvel état à partir du contact publié/hydraté.
 * Un refus retire ensuite la personne du brouillon (poste vacant + événement
 * `modified`) pour préparer la prochaine publication. Une acceptation ne
 * touche pas la structure du brouillon.
 */
function contactResponse(
  contact: AssignmentContact,
  status: AssignmentStatus,
  declineReason: DeclineReason | null,
): AssignmentContact {
  const now = new Date().toISOString();
  const next: AssignmentContact = {
    ...contact,
    status,
    respondedAt: now,
    assignedAt: contact.assignedAt ?? now,
    declineReason: status === 'declined' ? declineReason ?? undefined : undefined,
  };
  delete next.declineComment;
  return next;
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  if (!hasAnyPlanningFunction(auth.user.planningFunctions)) {
    return NextResponse.json({ error: 'Action réservée aux comptes personnels' }, { status: 403 });
  }

  const body = await request.json();
  const eventId = typeof body.eventId === 'string' ? body.eventId : '';
  const eventType = body.eventType;
  const role = body.role;
  const status = nextStatus(body.status);
  const parsedReason = parseIncomingDeclineReason(body.declineReason);
  if (!parsedReason.ok) {
    return NextResponse.json({ error: parsedReason.error }, { status: 400 });
  }
  const declineReason = parsedReason.reason;

  if (!eventId || !status || !validEventType(eventType) || !validRole(role)) {
    return NextResponse.json({ error: 'Réponse d’affectation invalide' }, { status: 400 });
  }
  if ((eventType === 'entrainement' || eventType === 'plateau') && role !== 'encadrant') {
    return NextResponse.json({ error: 'Rôle invalide pour cet événement' }, { status: 400 });
  }
  if (status === 'declined' && !declineReason) {
    return NextResponse.json({ error: 'Un motif de refus est requis' }, { status: 400 });
  }
  if (!hasPlanningFunction(auth.user.planningFunctions, functionForPlanningRole(role))) {
    return NextResponse.json({ error: 'Votre compte ne possède pas ce rôle' }, { status: 403 });
  }

  try {
    const db = await getDb();
    const publishedSnapshots = await listPublishedPlanningEventSnapshots(db);
    const published = publishedSnapshots
      ? publishedSnapshots.find((item) => item.eventType === eventType && item.eventId === eventId) ?? null
      : null;
    const snapshot = published
      ? (await hydratePlanningAssignmentStates(db, [published], auth.user.clubId))[0] ?? null
      : null;
    if (!snapshot) return NextResponse.json({ error: 'Affectation introuvable' }, { status: 404 });
    if (!isVisiblePublicationStatus(snapshot.planningStatus)) {
      const error = snapshot.planningStatus === 'cancelled'
        ? 'Cet événement a été annulé, votre réponse ne peut plus être modifiée.'
        : 'Cette affectation n’est pas publiée';
      return NextResponse.json({ error }, { status: 409 });
    }
    const publishedContact = snapshot.assignments[role].find((contact) => personIdentityMatches(contact, auth.user));
    if (!publishedContact) {
      return NextResponse.json({ error: 'Cette affectation ne vous appartient pas' }, { status: 403 });
    }

    // Issue #43 : le statut de confirmation est figé au coup d'envoi. Toute modification
    // postérieure fausserait l'historique, les statistiques de réponse et le suivi des
    // présences. L'heure de début est calculée dans le fuseau horaire du club.
    const { timeZone } = await readAppSettings(db, auth.user.clubId);
    const eventStart = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
    if (isResponseWindowClosed(eventStart)) {
      return NextResponse.json(
        { error: 'Cet événement a déjà commencé, votre réponse ne peut plus être modifiée.' },
        { status: 409 },
      );
    }

    const updatedContact = contactResponse(publishedContact, status, declineReason);
    await syncAssignmentStatesForRole(db, eventType, eventId, role, [updatedContact], auth.user.clubId);
    if (status === 'declined') {
      try {
        await vacateDeclinedAssignmentFromWorkingDraft(
          db,
          auth.user.clubId,
          eventType,
          eventId,
          role,
          { id: auth.user.id, nom: auth.user.nom },
        );
      } catch (error) {
        console.error('Impossible de retirer le refus du brouillon de préparation:', error);
      }
    }
    await logAuditEntry(db, {
      user: auth.user,
      entityType: 'PlanningAssignment',
      entityId: `${eventType}:${eventId}:${role}`,
      action: 'respond',
      before: { contact: redactAssignmentContactForAudit(publishedContact) },
      after: { contact: redactAssignmentContactForAudit(updatedContact) },
    });

    const reasonSuffix = assignmentDeclineNotificationSuffix(status, declineReason);
    await notifyAdmins(db, {
      type: status === 'declined' ? 'assignment-replacement-required' : 'assignment-response',
      title: status === 'accepted' ? 'Affectation acceptée' : 'Remplacement requis',
      message: status === 'accepted'
        ? `${auth.user.nom} a accepté son affectation (${role}).`
        : `${auth.user.nom} a refusé son affectation (${role}) sur ${snapshot.title}.${reasonSuffix} Un remplacement est requis si aucun autre affecté n’est actif.`,
      eventType,
      eventId,
    });

    return NextResponse.json({ success: true, status, declineReason });
  } catch (error) {
    console.error('Error responding to assignment:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer votre réponse' }, { status: 500 });
  }
}
