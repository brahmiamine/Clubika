import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { propagateAssignmentChangesIfPublished } from '@/lib/planning/assignment-propagation';
import { archivePlanningEvent, isPlanningEventCurrentlyPublished } from '@/lib/planning/event-lifecycle';
import { applyPlanningPublicationAction } from '@/lib/planning/publication-service';
import {
  canManagePlanningEventWorkspace,
  canReadPlanningEventWorkspace,
  personalPlanningAccessUser,
  resolvePlanningEventForAccess,
} from '@/lib/planning/event-access';
import {
  getPlanningEventSnapshot,
  PlanningConcurrencyError,
  saveBasePlanningEventOptimistically,
  saveOfficialMatchAdminOverrideOptimistically,
  savePlanningPublication,
  type PlanningEventType,
  type PlanningEventSnapshot,
  type PlanningRole,
} from '@/lib/planning/event-store';
import { applyPlanningEventUpdate } from '@/lib/planning/event-update';
import { createTeamLogoResolver } from '@/lib/planning/team-logos';
import { BodyValidator, parseJsonBody, RequestValidationError } from '@/lib/validation/request';
import type { Entrainement, Match, Plateau } from '@/types/match';
import { isClubAuthoredOfficialMatch } from '@/lib/privacy/sportcorico-data';
import { personIdentityMatches } from '@/lib/planning/person-link';

const VENUE_VALUES = ['domicile', 'extérieur'] as const;

function validEventType(value: string): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

const PERSONAL_ROLES: PlanningRole[] = ['arbitre', 'encadrant', 'accompagnateur'];

function personalSnapshot(snapshot: PlanningEventSnapshot, user: { id: number; nom: string }) {
  const assignments = {
    arbitre: snapshot.assignments.arbitre.filter((contact) => personIdentityMatches(contact, user)),
    encadrant: snapshot.assignments.encadrant.filter((contact) => personIdentityMatches(contact, user)),
    accompagnateur: snapshot.assignments.accompagnateur.filter((contact) => personIdentityMatches(contact, user)),
  };
  const myRoles = PERSONAL_ROLES.filter((role) => assignments[role].length > 0);
  const event = snapshot.eventType === 'entrainement' || snapshot.eventType === 'plateau'
    ? { ...snapshot.event, encadrants: assignments.encadrant }
    : snapshot.event;
  const extras = snapshot.extras
    ? {
        ...snapshot.extras,
        arbitreTouche: assignments.arbitre,
        contactEncadrants: assignments.encadrant,
        contactAccompagnateur: assignments.accompagnateur,
      }
    : null;
  return { ...snapshot, event, extras, assignments, myRoles };
}

async function resolveParams(
  params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string },
) {
  return params instanceof Promise ? await params : params;
}

function eventRevision(event: Match | Entrainement | Plateau): number {
  const raw = event.planningRevision;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function validateUpdate(eventType: PlanningEventType, body: Record<string, unknown>): void {
  const v = new BodyValidator(body);
  v.number('expectedRevision', { required: false, min: 0 });
  v.date('date', { required: false });
  v.time('time', { required: false });
  v.number('durationMinutes', { required: false, min: 1, max: 1440 });

  if (eventType === 'officiel' || eventType === 'amical') {
    v.string('competition', { required: false, maxLength: 128 });
    v.string('categorie', { required: false, maxLength: 64 });
    v.string('localTeam', { required: false, maxLength: 128 });
    v.string('awayTeam', { required: false, maxLength: 128 });
    v.enum('venue', VENUE_VALUES, { required: false });
    v.time('horaireRendezVous', { required: false });
    v.assignmentContacts('arbitreTouche');
    v.assignmentContacts('contactEncadrants');
    v.assignmentContacts('contactAccompagnateur');
  } else {
    v.string('lieu', { required: false, maxLength: 255 });
    v.assignmentContacts('encadrants');
    if (eventType === 'entrainement') {
      v.string('categorie', { required: false, maxLength: 64 });
    } else {
      v.stringArray('categories', { required: false, maxItemLength: 100 });
    }
  }
  v.throwIfInvalid();
}

function updateResponse(eventType: PlanningEventType, snapshot: PlanningEventSnapshot | null) {
  const base = { success: true, event: snapshot };
  if (!snapshot) return base;
  if (eventType === 'amical' || eventType === 'officiel') {
    return { ...base, match: snapshot.event, extras: snapshot.extras };
  }
  if (eventType === 'entrainement') return { ...base, entrainement: snapshot.event };
  return { ...base, plateau: snapshot.event };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const resolved = await resolveParams(params);
  if (!validEventType(resolved.eventType) || !resolved.eventId) {
    return NextResponse.json({ error: 'Événement invalide' }, { status: 400 });
  }

  const db = await getDb();
  const personalScope = new URL(request.url).searchParams.get('scope') === 'personal';
  const accessUser = personalScope ? personalPlanningAccessUser(auth.user) : auth.user;
  if (!accessUser) {
    return NextResponse.json({ error: 'Compte personnel non lié' }, { status: 403 });
  }

  const snapshot = await resolvePlanningEventForAccess(
    db,
    accessUser,
    resolved.eventType,
    resolved.eventId,
  );
  if (!snapshot) {
    return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });
  }
  if (!canReadPlanningEventWorkspace(accessUser, snapshot)) {
    return NextResponse.json({ error: 'Accès refusé' }, { status: 403 });
  }

  const teamLogos = await createTeamLogoResolver(db, auth.user.clubId);
  const visibleSnapshot = personalScope ? personalSnapshot(snapshot, accessUser) : snapshot;
  return NextResponse.json({
    ...visibleSnapshot,
    ...teamLogos(snapshot.event),
    canManage: canManagePlanningEventWorkspace(accessUser),
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const resolved = await resolveParams(params);
  if (!validEventType(resolved.eventType) || !resolved.eventId) {
    return NextResponse.json({ error: 'Événement invalide' }, { status: 400 });
  }
  const eventType = resolved.eventType;
  const eventId = resolved.eventId;

  try {
    const body = parseJsonBody(await request.json());
    validateUpdate(eventType, body);

    const db = await getDb();
    const preSnapshot = await getPlanningEventSnapshot(db, eventType, eventId);
    if (!preSnapshot) {
      return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });
    }

    const expectedRevisionRaw = body.expectedRevision;
    const expectedRevision = typeof expectedRevisionRaw === 'number' && Number.isFinite(expectedRevisionRaw)
      ? expectedRevisionRaw
      : (preSnapshot.revision ?? 0);
    if (expectedRevision !== (preSnapshot.revision ?? 0)) {
      throw new PlanningConcurrencyError();
    }

    const before = {
      ...(preSnapshot.event as unknown as Record<string, unknown>),
      ...(eventType === 'amical' ? { extras: preSnapshot.extras } : {}),
      ...(eventType === 'officiel'
        ? { sourceOverride: preSnapshot.sourceOverride ?? { active: false, changedFields: [], source: null } }
        : {}),
    };

    let updated = applyPlanningEventUpdate(eventType, preSnapshot.event, body);
    const beforeEncadrants = eventType === 'entrainement' || eventType === 'plateau'
      ? preSnapshot.assignments.encadrant
      : [];

    if ((eventType === 'entrainement' || eventType === 'plateau') && body.encadrants !== undefined) {
      updated = {
        ...updated,
        encadrants: await enrichAssignmentContacts(
          db,
          auth.user.clubId,
          body.encadrants,
          'encadrant',
          preSnapshot.assignments.encadrant,
        ),
      } as Entrainement | Plateau;
    }

    if (
      (eventType === 'entrainement' || eventType === 'plateau')
      && preSnapshot.planningStatus === 'published'
    ) {
      updated = {
        ...updated,
        planningStatus: 'modified',
        modifiedAfterPublishAt: new Date().toISOString(),
      } as Entrainement | Plateau;
    }

    const auditEntityType = eventType === 'officiel'
      ? 'MatchOfficial'
      : eventType === 'amical'
        ? 'MatchAmical'
        : eventType === 'entrainement'
          ? 'Entrainement'
          : 'Plateau';

    const refreshed = await db.transaction(async (manager) => {
      if (eventType === 'officiel') {
        await saveOfficialMatchAdminOverrideOptimistically(
          manager,
          eventId,
          updated as Match,
          expectedRevision,
          { id: auth.user.id, email: auth.user.email },
          {
            revertToSource: body.revertToSource === true,
            markPublishedModified: preSnapshot.planningStatus === 'published',
          },
        );
      } else if (eventType === 'amical') {
        // La révision publique d'un match amical vit dans MatchExtra tandis que la source
        // MatchAmical a sa propre révision. On verrouille les deux dans la même transaction :
        // la révision lue par le client contrôle MatchExtra, et la source utilise sa révision
        // interne courante. Cela évite le faux 409 au deuxième edit d'un brouillon.
        await saveBasePlanningEventOptimistically(
          manager,
          eventType,
          eventId,
          updated as Match,
          eventRevision(preSnapshot.event),
        );

        const extrasPatch: Record<string, unknown> = {};
        if (body.arbitreTouche !== undefined) {
          extrasPatch.arbitreTouche = await enrichAssignmentContacts(
            manager,
            auth.user.clubId,
            body.arbitreTouche,
            'officiel',
            preSnapshot.assignments.arbitre,
          );
        }
        if (body.contactEncadrants !== undefined) {
          extrasPatch.contactEncadrants = await enrichAssignmentContacts(
            manager,
            auth.user.clubId,
            body.contactEncadrants,
            'encadrant',
            preSnapshot.assignments.encadrant,
          );
        }
        if (body.contactAccompagnateur !== undefined) {
          extrasPatch.contactAccompagnateur = await enrichAssignmentContacts(
            manager,
            auth.user.clubId,
            body.contactAccompagnateur,
            'accompagnateur',
            preSnapshot.assignments.accompagnateur,
          );
        }
        if (preSnapshot.planningStatus === 'published') {
          extrasPatch.planningStatus = 'modified';
          extrasPatch.modifiedAfterPublishAt = new Date().toISOString();
        }

        // Même avec un patch vide, on incrémente la révision canonique des extras afin que
        // deux mises à jour consécutives d'un amical utilisent une révision cohérente.
        await savePlanningPublication(manager, preSnapshot, extrasPatch);
      } else {
        await saveBasePlanningEventOptimistically(
          manager,
          eventType,
          eventId,
          updated as Entrainement | Plateau,
          expectedRevision,
        );
      }

      const next = await getPlanningEventSnapshot(manager, eventType, eventId);
      await logAuditEntry(manager, {
        user: auth.user,
        entityType: auditEntityType,
        entityId: eventId,
        action: 'update',
        before,
        after: next
          ? {
              ...(next.event as unknown as Record<string, unknown>),
              ...(eventType === 'amical' ? { extras: next.extras } : {}),
              ...(eventType === 'officiel'
                ? { sourceOverride: next.sourceOverride ?? { active: false, changedFields: [], source: null } }
                : {}),
            }
          : null,
      });
      return next;
    });

    if (
      refreshed
      && (eventType === 'entrainement' || eventType === 'plateau')
      && body.encadrants !== undefined
    ) {
      await propagateAssignmentChangesIfPublished(
        db,
        auth.user.clubId,
        refreshed,
        beforeEncadrants,
        refreshed.assignments.encadrant,
      );
    }

    return NextResponse.json(updateResponse(eventType, refreshed));
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: 'Requête invalide', details: error.issues }, { status: 400 });
    }
    if (error instanceof PlanningConcurrencyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logError('app.unhandled', 'Planning event update failed:', error);
    return NextResponse.json({ error: 'Impossible de modifier cet événement' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const resolved = await resolveParams(params);
  if (!validEventType(resolved.eventType) || !resolved.eventId) {
    return NextResponse.json({ error: 'Événement invalide' }, { status: 400 });
  }
  const eventType = resolved.eventType;
  const eventId = resolved.eventId;

  try {
    const db = await getDb();
    const snapshot = await getPlanningEventSnapshot(db, eventType, eventId);
    if (!snapshot) {
      return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });
    }
    if (eventType === 'officiel' && !isClubAuthoredOfficialMatch(snapshot.event as Match)) {
      return NextResponse.json(
        { error: 'Un match officiel issu d’une source tierce ne peut pas être supprimé manuellement.' },
        { status: 405 },
      );
    }

    const alreadyPublished = await isPlanningEventCurrentlyPublished(
      db,
      auth.user.clubId,
      eventType,
      eventId,
    );
    if (alreadyPublished) {
      const planningStatus = await applyPlanningPublicationAction(
        db,
        auth.user,
        snapshot,
        'cancel',
        'Suppression préparée depuis le planning',
      );
      return NextResponse.json({ success: true, deferred: true, planningStatus });
    }

    await db.transaction(async (manager) => {
      await archivePlanningEvent(manager, eventType, eventId, auth.user.id, auth.user.clubId);
      if (eventType === 'amical') {
        await manager.getRepository('MatchAmical').delete({ id: eventId, clubId: auth.user.clubId });
      } else if (eventType === 'officiel') {
        await manager.getRepository('MatchOfficial').delete({ id: eventId, clubId: auth.user.clubId });
        await manager.getRepository('MatchExtra').delete({ matchId: eventId, clubId: auth.user.clubId });
      } else if (eventType === 'entrainement') {
        await manager.getRepository('Entrainement').delete({ id: eventId, clubId: auth.user.clubId });
      } else {
        await manager.getRepository('Plateau').delete({ id: eventId, clubId: auth.user.clubId });
      }
      await logAuditEntry(manager, {
        user: auth.user,
        entityType: eventType === 'amical'
          ? 'MatchAmical'
          : eventType === 'officiel'
            ? 'MatchOfficial'
            : eventType === 'entrainement' ? 'Entrainement' : 'Plateau',
        entityId: eventId,
        action: 'delete',
        before: snapshot.event as unknown as Record<string, unknown>,
        after: null,
      });
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logError('app.unhandled', 'Planning event delete failed:', error);
    return NextResponse.json({ error: 'Impossible de supprimer cet événement' }, { status: 500 });
  }
}
