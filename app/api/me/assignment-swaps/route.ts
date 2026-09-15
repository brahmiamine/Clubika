import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { hasAnyPlanningFunction, hasPlanningFunction } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { logAuditEntry } from '@/lib/db/audit-log';
import { createNotificationForUser, deliverEnqueuedNotifications, enqueueAdminNotificationIntents, enqueueUserNotificationIntents, type EnqueuedContactNotification } from '@/lib/notifications/service';
import { buildAssignmentSuggestions } from '@/lib/planning/assignment-suggestions';
import {
  AssignmentSwapConflictError,
  AssignmentSwapNotFoundError,
  AssignmentSwapValidationError,
  assignmentContactForUser,
  closeStaleAssignmentSwaps,
  isAssignmentSwapOpen,
  requesterStillAssigned,
  rolePersonType,
  transitionAssignmentSwap,
  userHasPersonLink,
  type AssignmentSwapPayload,
} from '@/lib/planning/assignment-swaps';
import { type PlanningEventType, type PlanningRole } from '@/lib/planning/event-store';
import { functionForPlanningRole, userHoldsFunction } from '@/lib/planning/person-link';
import { resolvePlanningEventForAccess } from '@/lib/planning/event-access';
import { eventStartTimestamp, isVisiblePublicationStatus } from '@/lib/planning/p0-rules';
import {
  getPlanningRecord,
  listPlanningRecords,
  planningRecordId,
  savePlanningRecord,
  type PlanningRecordKind,
} from '@/lib/planning/records';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';

const SWAP_KIND = 'assignment-swap' as PlanningRecordKind;

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validRole(value: unknown): value is PlanningRole {
  return value === 'arbitre' || value === 'encadrant' || value === 'accompagnateur';
}

// Les candidats à un échange sont toujours limités au club courant (frontière tenant, issue #154).
async function activeUsers(db: Awaited<ReturnType<typeof getDb>>, clubId: string): Promise<UserEntity[]> {
  return db.getRepository<UserEntity>('User').find({ where: { active: true, clubId } });
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  if (!hasAnyPlanningFunction(auth.user.planningFunctions)) {
    return NextResponse.json({ error: 'Action réservée aux comptes personnels' }, { status: 403 });
  }

  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'assignmentSwaps');
  if (disabled) return disabled;
  // Clôture les demandes devenues caduques (événement passé, annulé, affectation
  // retirée) avant d'afficher les listes (issue #81).
  await closeStaleAssignmentSwaps(db);
  const records = await listPlanningRecords<AssignmentSwapPayload>(db, { kind: SWAP_KIND }, 500);
  const mine = records.filter((record) => record.payload.requester.userId === auth.user.id);
  const incoming = records.filter((record) => record.payload.target.userId === auth.user.id);

  const url = new URL(request.url);
  const eventType = url.searchParams.get('eventType');
  const eventId = url.searchParams.get('eventId')?.trim();
  const role = url.searchParams.get('role');
  if (!eventType && !eventId && !role) return NextResponse.json({ mine, incoming, candidates: [] });
  if (!eventId || !validEventType(eventType) || !validRole(role)) {
    return NextResponse.json({ error: 'Événement ou rôle invalide' }, { status: 400 });
  }
  if (!hasPlanningFunction(auth.user.planningFunctions, functionForPlanningRole(role))) {
    return NextResponse.json({ error: 'Votre compte ne possède pas la fonction de cette affectation' }, { status: 403 });
  }

  const snapshot = await resolvePlanningEventForAccess(db, auth.user, eventType, eventId);
  if (!snapshot || !isVisiblePublicationStatus(snapshot.planningStatus)) {
    return NextResponse.json({ error: 'Affectation introuvable' }, { status: 404 });
  }
  if (!assignmentContactForUser(auth.user, snapshot.assignments[role])) {
    return NextResponse.json({ error: 'Cette affectation ne vous appartient pas' }, { status: 403 });
  }

  const users = await activeUsers(db, auth.user.clubId);
  const suggestions = await buildAssignmentSuggestions(db, snapshot, role, 20);
  const candidates = suggestions.flatMap((suggestion) => {
    const user = users.find((candidate) => candidate.id !== auth.user.id
      && userHoldsFunction(candidate, functionForPlanningRole(role))
      && userHasPersonLink(candidate, suggestion.personType, suggestion.personId));
    return user ? [{ ...suggestion, userId: user.id }] : [];
  });
  return NextResponse.json({ mine, incoming, candidates });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  if (!hasAnyPlanningFunction(auth.user.planningFunctions)) {
    return NextResponse.json({ error: 'Action réservée aux comptes personnels' }, { status: 403 });
  }

  try {
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'assignmentSwaps');
    if (disabled) return disabled;
    const body = await request.json();
    const action = typeof body.action === 'string' ? body.action : 'create';

    if (action === 'create') {
      const eventType = body.eventType;
      const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
      const role = body.role;
      const targetUserId = Number(body.targetUserId);
      const targetPersonId = Number(body.targetPersonId);
      const targetPersonType = body.targetPersonType;
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) || null : null;
      if (!eventId || !validEventType(eventType) || !validRole(role)
        || !Number.isInteger(targetUserId) || targetUserId <= 0
        || !Number.isInteger(targetPersonId) || targetPersonId <= 0
        || targetPersonType !== rolePersonType(role)) {
        return NextResponse.json({ error: 'Demande d’échange invalide' }, { status: 400 });
      }
      if (!hasPlanningFunction(auth.user.planningFunctions, functionForPlanningRole(role))) {
        return NextResponse.json({ error: 'Votre compte ne possède pas la fonction de cette affectation' }, { status: 403 });
      }

      const snapshot = await resolvePlanningEventForAccess(db, auth.user, eventType, eventId);
      if (!snapshot || !isVisiblePublicationStatus(snapshot.planningStatus)) {
        return NextResponse.json({ error: 'Affectation introuvable' }, { status: 404 });
      }
      // Un échange ne peut concerner qu'un événement à venir, dans le fuseau du club (issue #45).
      const { timeZone } = await readAppSettings(db, auth.user.clubId);
      const start = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
      if (start === null || start <= Date.now()) {
        return NextResponse.json({ error: 'Un échange ne peut concerner qu’un événement à venir' }, { status: 409 });
      }
      const requesterContact = assignmentContactForUser(auth.user, snapshot.assignments[role]);
      if (!requesterContact?.personType || requesterContact.personId === undefined) {
        return NextResponse.json({ error: 'Cette affectation ne vous appartient pas' }, { status: 403 });
      }

      const suggestions = await buildAssignmentSuggestions(db, snapshot, role, 20);
      const targetSuggestion = suggestions.find((item) => item.personId === targetPersonId && item.personType === targetPersonType);
      if (!targetSuggestion) {
        return NextResponse.json({ error: 'La personne ciblée n’est plus éligible ou présente un conflit' }, { status: 409 });
      }
      const targetUser = await db.getRepository<UserEntity>('User').findOneBy({ id: targetUserId, active: true, clubId: auth.user.clubId });
      if (!targetUser || targetUser.id === auth.user.id
        || !userHoldsFunction(targetUser, functionForPlanningRole(role))
        || !userHasPersonLink(targetUser, targetPersonType, targetPersonId)) {
        return NextResponse.json({ error: 'Utilisateur cible introuvable ou fonction incompatible' }, { status: 404 });
      }

      const existing = await listPlanningRecords<AssignmentSwapPayload>(db, { kind: SWAP_KIND, eventType, eventId }, 100);
      if (existing.some((record) => record.payload.requester.userId === auth.user.id
        && record.payload.role === role && isAssignmentSwapOpen(record.payload.status))) {
        return NextResponse.json({ error: 'Une demande d’échange est déjà ouverte pour cette affectation' }, { status: 409 });
      }

      const now = new Date().toISOString();
      const id = planningRecordId(SWAP_KIND);
      const payload: AssignmentSwapPayload = {
        role,
        eventType,
        eventId,
        eventTitle: snapshot.title,
        eventDate: snapshot.date,
        eventTime: snapshot.time,
        requester: {
          userId: auth.user.id,
          personType: requesterContact.personType,
          personId: requesterContact.personId,
          nom: auth.user.nom,
        },
        target: {
          userId: targetUser.id,
          personType: targetPersonType,
          personId: targetPersonId,
          nom: targetUser.nom,
        },
        status: 'pending-target',
        message,
        createdAt: now,
        targetRespondedAt: null,
        adminRespondedAt: null,
        adminUserId: null,
      };
      await savePlanningRecord(db, { id, kind: SWAP_KIND, eventType, eventId, ownerUserId: auth.user.id, payload });
      await createNotificationForUser(db, targetUser, {
        type: 'assignment-swap-requested',
        title: 'Proposition d’échange d’affectation',
        message: `${auth.user.nom} vous propose son affectation ${snapshot.title} du ${snapshot.date} à ${snapshot.time}.`,
        eventType,
        eventId,
        urgency: 'important',
      });
      await logAuditEntry(db, {
        user: auth.user,
        entityType: 'AssignmentSwap',
        entityId: id,
        action: 'create',
        before: null,
        after: payload as unknown as Record<string, unknown>,
      });
      return NextResponse.json({ success: true, swap: { id, ...payload } });
    }

    const recordId = typeof body.recordId === 'string' ? body.recordId.trim() : '';
    const record = recordId ? await getPlanningRecord<AssignmentSwapPayload>(db, recordId) : null;
    if (!record || record.kind !== SWAP_KIND) return NextResponse.json({ error: 'Demande d’échange introuvable' }, { status: 404 });

    if (action === 'cancel') {
      // L'appartenance (403) est vérifiée avant d'entrer dans la transition verrouillée :
      // un utilisateur qui n'est pas le demandeur ne doit jamais apprendre, via un 409,
      // qu'une demande qui n'est pas la sienne a déjà été traitée entre-temps.
      if (record.payload.requester.userId !== auth.user.id) {
        return NextResponse.json({ error: 'Cette demande ne peut pas être annulée' }, { status: 403 });
      }

      let enqueued: EnqueuedContactNotification[] = [];
      // Verrou de la ligne + transition conditionnelle (issue #285) : une annulation ne
      // peut jamais réussir sur une demande déjà traitée par ailleurs (cible, admin,
      // clôture automatique) entre la lecture ci-dessus et cette tentative.
      const status = await transitionAssignmentSwap(db, recordId, 'requester', 'cancel', async (manager, current, nextStatus) => {
        const nextPayload = { ...current.payload, status: nextStatus };
        const target = await manager.getRepository<UserEntity>('User').findOneBy({ id: current.payload.target.userId, clubId: auth.user.clubId });
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'AssignmentSwap',
          entityId: current.id,
          action: 'update',
          before: current.payload as unknown as Record<string, unknown>,
          after: nextPayload as unknown as Record<string, unknown>,
        });
        if (target) {
          enqueued = await enqueueUserNotificationIntents(manager, target, {
            type: 'assignment-swap-cancelled',
            title: 'Échange annulé',
            message: `${auth.user.nom} a annulé sa demande d’échange.`,
            eventType: current.eventType,
            eventId: current.eventId,
          }, `swap:${current.id}:${nextStatus}:target`);
        }
        return { payload: nextPayload, result: nextStatus };
      });

      await deliverEnqueuedNotifications(db, enqueued);
      return NextResponse.json({ success: true, status });
    }

    if (action === 'respond') {
      if (record.payload.target.userId !== auth.user.id) return NextResponse.json({ error: 'Cette demande ne vous est pas destinée' }, { status: 403 });
      if (!hasPlanningFunction(auth.user.planningFunctions, functionForPlanningRole(record.payload.role))) {
        return NextResponse.json({ error: 'Votre compte ne possède plus la fonction requise' }, { status: 409 });
      }
      const decision = body.decision === 'accept' ? 'accept' : body.decision === 'decline' ? 'decline' : null;
      if (!decision) return NextResponse.json({ error: 'Réponse invalide' }, { status: 400 });

      let enqueued: EnqueuedContactNotification[] = [];
      // Même principe que côté admin (issue #285) : verrou + transition conditionnelle,
      // revalidation métier et audit/notifications dans la même transaction ; seule la
      // livraison réseau reste après le commit.
      const status = await transitionAssignmentSwap(db, recordId, 'target', decision, async (manager, current, nextStatus) => {
        // Revalidation avant la réponse de la cible (issue #81), comme côté approbation
        // admin : l'événement doit être toujours publié, à venir (fuseau du club) et
        // l'affectation du demandeur encore en place — sinon un « accept » tardif
        // déclencherait une validation admin pour un échange impossible.
        const snapshot = await resolvePlanningEventForAccess(manager, auth.user, current.payload.eventType, current.payload.eventId);
        if (!snapshot || !isVisiblePublicationStatus(snapshot.planningStatus)) {
          throw new AssignmentSwapValidationError('Cet événement n’est plus publié, l’échange n’est plus possible');
        }
        const { timeZone } = await readAppSettings(manager, auth.user.clubId);
        const swapStart = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
        if (swapStart === null || swapStart <= Date.now()) {
          throw new AssignmentSwapValidationError('Cet événement a déjà commencé, l’échange n’est plus possible');
        }
        if (!requesterStillAssigned(current.payload, snapshot)) {
          throw new AssignmentSwapValidationError('L’affectation du demandeur a changé depuis la demande');
        }

        const nextPayload = { ...current.payload, status: nextStatus, targetRespondedAt: new Date().toISOString() };
        const requester = await manager.getRepository<UserEntity>('User').findOneBy({ id: current.payload.requester.userId, clubId: auth.user.clubId });

        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'AssignmentSwap',
          entityId: current.id,
          action: 'update',
          before: current.payload as unknown as Record<string, unknown>,
          after: nextPayload as unknown as Record<string, unknown>,
        });

        const idempotencyBase = `swap:${current.id}:${nextStatus}`;
        const requesterNotify = requester ? await enqueueUserNotificationIntents(manager, requester, {
          type: decision === 'accept' ? 'assignment-swap-target-accepted' : 'assignment-swap-target-declined',
          title: decision === 'accept' ? 'Échange accepté par la cible' : 'Échange refusé',
          message: decision === 'accept' ? `${auth.user.nom} accepte l’échange. Validation administrateur requise.` : `${auth.user.nom} refuse l’échange.`,
          eventType: current.eventType,
          eventId: current.eventId,
          urgency: decision === 'accept' ? 'important' : 'normal',
        }, `${idempotencyBase}:requester`) : [];
        const adminNotify = decision === 'accept' ? await enqueueAdminNotificationIntents(manager, {
          type: 'assignment-swap-admin-review',
          title: 'Échange à valider',
          message: `${current.payload.requester.nom} et ${current.payload.target.nom} ont accepté un échange sur ${current.payload.eventTitle}.`,
          eventType: current.eventType,
          eventId: current.eventId,
          urgency: 'important',
        }, `${idempotencyBase}:admins`) : [];
        enqueued = [...requesterNotify, ...adminNotify];

        return { payload: nextPayload, result: nextStatus };
      });

      await deliverEnqueuedNotifications(db, enqueued);
      return NextResponse.json({ success: true, status });
    }

    return NextResponse.json({ error: 'Action d’échange invalide' }, { status: 400 });
  } catch (error) {
    if (error instanceof AssignmentSwapNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof AssignmentSwapConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof AssignmentSwapValidationError) return NextResponse.json({ error: error.message }, { status: error.status });
    logError('app.unhandled', 'Personal assignment swap failed:', error);
    return NextResponse.json({ error: 'Impossible de traiter la demande d’échange' }, { status: 500 });
  }
}
