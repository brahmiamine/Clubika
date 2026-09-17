import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  getPlanningEventSnapshot,
  saveRoleAssignments,
  PlanningConcurrencyError,
  type PlanningEventType,
  type PlanningRole,
} from '@/lib/planning/event-store';
import { buildAssignmentSuggestions } from '@/lib/planning/assignment-suggestions';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { propagateAssignmentChangesIfPublished } from '@/lib/planning/assignment-propagation';
import { hasCoveredRole, needsReplacement } from '@/lib/planning/p0-rules';
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

/**
 * GET : calcule et renvoie des suggestions de candidats (score + raisons) pour un rôle
 * vacant ou à remplacer. Lecture seule (issue #15) : n'écrit jamais, n'auditionne jamais
 * une décision — seule la confirmation explicite via POST modifie le planning. Voir
 * `docs/planning-auto-assign.md` pour les critères pris en compte et les limites connues
 * de l'algorithme.
 */
export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const { searchParams } = new URL(request.url);
  const eventType = searchParams.get('eventType');
  const eventId = searchParams.get('eventId')?.trim() ?? '';
  const role = searchParams.get('role');
  const limitRaw = Number.parseInt(searchParams.get('limit') ?? '20', 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;

  if (!eventId || !validEventType(eventType) || !validRole(role)) {
    return NextResponse.json({ error: 'Demande de suggestion invalide' }, { status: 400 });
  }

  try {
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'autoAssignment');
    if (disabled) return disabled;
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
      alreadyCovered: hasCoveredRole(snapshot.assignments[role]),
      suggestions,
    });
  } catch (error) {
    logError('app.unhandled', 'Assignment suggestions failed:', error);
    return NextResponse.json({ error: 'Impossible de générer les suggestions' }, { status: 500 });
  }
}

/**
 * POST : confirme une affectation. Exige un `personId` explicite (issue #15) — jamais de
 * choix implicite du premier candidat. Recalcule intégralement les suggestions à cet
 * instant (indisponibilité, conflit, charge, éligibilité à la fonction) plutôt que de faire
 * confiance à une liste éventuellement affichée plus tôt à l'admin : entre l'affichage des
 * suggestions et la confirmation, un autre changement a pu rendre le candidat inéligible.
 * `saveRoleAssignments` verrouille ensuite la ligne et compare la révision réellement
 * persistée à celle lue au début de la requête ; une confirmation concurrente sur le même
 * événement échoue avec 409 plutôt que d'écraser silencieusement l'autre affectation.
 */
export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const eventType = body.eventType;
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    const role = body.role;
    const force = body.force === true;
    const personId = typeof body.personId === 'number'
      && Number.isInteger(body.personId)
      && body.personId > 0
      ? body.personId
      : null;

    if (!eventId || !validEventType(eventType) || !validRole(role)) {
      return NextResponse.json({ error: 'Demande d’affectation invalide' }, { status: 400 });
    }
    if (personId === null) {
      return NextResponse.json(
        { error: 'personId requis : choisissez explicitement une personne avant de confirmer l’affectation' },
        { status: 400 },
      );
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

    const suggestions = await buildAssignmentSuggestions(db, snapshot, role, 50);
    const selected = suggestions.find((candidate) => candidate.personId === personId);

    if (!selected) {
      return NextResponse.json(
        {
          error: 'Cette personne n’est plus disponible ou éligible pour cette affectation (indisponibilité, '
            + 'conflit d’horaire, charge ou fonction requise). Rafraîchissez les suggestions et confirmez à '
            + 'nouveau, ou affectez-la manuellement depuis la fiche de l’événement pour déroger à l’algorithme.',
        },
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
    // Si l'événement est déjà publié, cette affectation confirmée marque l'événement `modified`
    // et attend la prochaine publication globale comme toute affectation admin (issue #197) ;
    // sinon rien à signaler avant la première publication.
    await propagateAssignmentChangesIfPublished(db, auth.user.clubId, snapshot, before, next);
    // Journalise l'acteur (auth.user, via userId) et la personne choisie uniquement : ni les
    // autres candidats évalués ni leurs raisons ne sont conservés, afin de ne pas garder de
    // trace de profilage au-delà du nécessaire (issue #15). L'entrée suit ensuite la purge de
    // rétention standard des journaux d'audit (voir docs/retention.md).
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
    if (error instanceof PlanningConcurrencyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logError('app.unhandled', 'Auto assignment failed:', error);
    return NextResponse.json({ error: 'Impossible d’effectuer l’affectation automatique' }, { status: 500 });
  }
}
