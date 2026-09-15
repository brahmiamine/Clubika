import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { logAuditEntry } from '@/lib/db/audit-log';
import { deliverEnqueuedNotifications, enqueueUserNotificationIntents, type EnqueuedContactNotification } from '@/lib/notifications/service';
import { buildAssignmentSuggestions } from '@/lib/planning/assignment-suggestions';
import {
  AssignmentSwapConflictError,
  AssignmentSwapNotFoundError,
  AssignmentSwapValidationError,
  closeStaleAssignmentSwaps,
  transitionAssignmentSwap,
  type AssignmentSwapPayload,
} from '@/lib/planning/assignment-swaps';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { getPlanningEventSnapshot, saveRoleAssignments } from '@/lib/planning/event-store';
import { functionForPlanningRole, userHoldsFunction } from '@/lib/planning/person-link';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { syncAssignmentStatesForRole } from '@/lib/planning/assignment-state-store';
import {
  getPublishedPlanningEventSnapshot,
  patchPublishedPlanningEventAssignments,
} from '@/lib/planning/published-planning';
import { eventStartTimestamp, isVisiblePublicationStatus } from '@/lib/planning/p0-rules';
import { listPlanningRecords, type PlanningRecordKind } from '@/lib/planning/records';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { PlanningValidationError } from '@/lib/planning/validation';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';

const SWAP_KIND = 'assignment-swap' as PlanningRecordKind;

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'assignmentSwaps');
  if (disabled) return disabled;
  // Clôture les demandes devenues caduques avant d'afficher la file admin (issue #81).
  await closeStaleAssignmentSwaps(db);
  const records = await listPlanningRecords<AssignmentSwapPayload>(db, { kind: SWAP_KIND }, 500);
  return NextResponse.json({
    swaps: records.filter((record) => record.payload.status === 'pending-admin'),
    recent: records.slice(0, 100),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const recordId = typeof body.recordId === 'string' ? body.recordId.trim() : '';
    const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
    if (!recordId || !decision) return NextResponse.json({ error: 'Décision invalide' }, { status: 400 });

    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'assignmentSwaps');
    if (disabled) return disabled;

    let enqueued: EnqueuedContactNotification[] = [];

    // Verrou de la ligne + transition conditionnelle (issue #285) : deux décisions admin
    // concurrentes (ou une décision admin concurrente à une clôture automatique) sur le
    // même échange ne peuvent jamais toutes deux réussir — la seconde relit un statut déjà
    // changé et échoue avec un 409 déterministe, jamais un 500 générique ni un statut de
    // demande incohérent avec l'affectation effectivement appliquée.
    const status = await transitionAssignmentSwap(db, recordId, 'admin', decision, async (manager, record, nextStatus) => {
      // Recherche par clé composée id + clubId : un identifiant d'un autre club ne doit
      // jamais résoudre un utilisateur (frontière tenant, issue #154).
      const requester = await manager.getRepository<UserEntity>('User').findOneBy({ id: record.payload.requester.userId, clubId: auth.user.clubId });
      const target = await manager.getRepository<UserEntity>('User').findOneBy({ id: record.payload.target.userId, clubId: auth.user.clubId });
      if (!requester?.active || !target?.active) {
        throw new AssignmentSwapValidationError('Un utilisateur de l’échange est introuvable ou inactif');
      }
      if (!userHoldsFunction(target, functionForPlanningRole(record.payload.role))) {
        throw new AssignmentSwapValidationError('La personne cible ne possède plus la fonction requise');
      }

      const nextPayload: AssignmentSwapPayload = {
        ...record.payload,
        status: nextStatus,
        adminRespondedAt: new Date().toISOString(),
        adminUserId: auth.user.id,
      };

      if (decision === 'approve') {
        const rawSnapshot = await getPlanningEventSnapshot(manager, record.payload.eventType, record.payload.eventId);
        const snapshot = rawSnapshot
          ? (await hydratePlanningAssignmentStates(manager, [rawSnapshot], auth.user.clubId))[0] ?? null
          : null;
        if (!snapshot) throw new AssignmentSwapValidationError('Événement introuvable', 404);
        if (!isVisiblePublicationStatus(snapshot.planningStatus)) {
          throw new AssignmentSwapValidationError('Cet événement n’est plus publié');
        }
        const publishedSnapshot = await getPublishedPlanningEventSnapshot(
          manager,
          record.payload.eventType,
          record.payload.eventId,
        );
        if (!publishedSnapshot) {
          throw new AssignmentSwapValidationError('Cet événement n’est plus publié');
        }

        // L'échange devient immédiatement visible sur le créneau encore publié tout en étant
        // appliqué au brouillon courant. Les deux créneaux doivent donc rester futurs et libres.
        const { timeZone } = await readAppSettings(manager, auth.user.clubId);
        const liveStart = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
        const publishedStart = eventStartTimestamp(publishedSnapshot.date, publishedSnapshot.time, timeZone);
        if (liveStart === null || publishedStart === null || liveStart <= Date.now() || publishedStart <= Date.now()) {
          throw new AssignmentSwapValidationError('Cet événement a déjà commencé ou sa date est invalide');
        }

        const before = snapshot.assignments[record.payload.role];
        const requesterStillAssignedToEvent = before.some((contact) => contact.status !== 'declined'
          && contact.personType === record.payload.requester.personType
          && contact.personId === record.payload.requester.personId);
        if (!requesterStillAssignedToEvent) {
          throw new AssignmentSwapValidationError('L’affectation du demandeur a changé depuis la demande');
        }

        const [liveSuggestions, publishedSuggestions] = await Promise.all([
          buildAssignmentSuggestions(manager, snapshot, record.payload.role, 20),
          buildAssignmentSuggestions(manager, publishedSnapshot, record.payload.role, 20),
        ]);
        const candidate = liveSuggestions.find((item) => item.personType === record.payload.target.personType
          && item.personId === record.payload.target.personId);
        const publishedCandidate = publishedSuggestions.find((item) => item.personType === record.payload.target.personType
          && item.personId === record.payload.target.personId);
        if (!candidate || !publishedCandidate) {
          throw new AssignmentSwapValidationError('La personne cible n’est plus disponible ou présente désormais un conflit');
        }

        const retained = before.filter((contact) => !(contact.personType === record.payload.requester.personType
          && contact.personId === record.payload.requester.personId));
        const next = await enrichAssignmentContacts(manager, auth.user.clubId, [
          ...retained,
          {
            nom: candidate.nom,
            numero: candidate.telephone ?? '',
            personType: candidate.personType,
            personId: candidate.personId,
            status: 'accepted',
            assignedAt: new Date().toISOString(),
            respondedAt: record.payload.targetRespondedAt ?? new Date().toISOString(),
          },
        ], candidate.personType, retained);

        await saveRoleAssignments(manager, snapshot, record.payload.role, next);
        await syncAssignmentStatesForRole(
          manager,
          snapshot.eventType,
          snapshot.eventId,
          record.payload.role,
          next,
          auth.user.clubId,
        );

        // Un remplacement validé par l'admin est annoncé aux deux personnes comme effectif
        // immédiatement : contrairement à une modification de préparation classique, il ne
        // doit pas attendre la prochaine publication globale pour apparaître sur /mon-planning,
        // l'iCal ou les échanges suivants.
        const refreshedSnapshot = await getPlanningEventSnapshot(manager, record.payload.eventType, record.payload.eventId);
        if (refreshedSnapshot) {
          await patchPublishedPlanningEventAssignments(
            manager,
            auth.user.clubId,
            refreshedSnapshot.eventType,
            refreshedSnapshot.eventId,
            record.payload.role,
            next,
          );
        }
      }

      // Audit et intentions de notification dans la MÊME transaction que le statut et
      // l'affectation (issue #285, prolongeant le même principe que la publication
      // globale, issue #276) : soit tout est acté ensemble, soit rien ne l'est. Seule la
      // livraison réseau réelle reste après le commit (`deliverEnqueuedNotifications`).
      await logAuditEntry(manager, {
        user: auth.user,
        entityType: 'AssignmentSwap',
        entityId: record.id,
        action: decision === 'approve' ? 'approve' : 'reject',
        before: record.payload as unknown as Record<string, unknown>,
        after: nextPayload as unknown as Record<string, unknown>,
      });

      const title = decision === 'approve' ? 'Échange d’affectation validé' : 'Échange d’affectation refusé';
      const message = decision === 'approve'
        ? `L’échange pour ${record.payload.eventTitle} du ${record.payload.eventDate} à ${record.payload.eventTime} est validé.`
        : `L’administrateur a refusé l’échange pour ${record.payload.eventTitle}.`;
      const idempotencyBase = `swap:${record.id}:${nextStatus}`;
      enqueued = [
        ...(await enqueueUserNotificationIntents(manager, requester, {
          type: `assignment-swap-${nextStatus}`, title, message, eventType: record.eventType, eventId: record.eventId, urgency: 'important',
        }, `${idempotencyBase}:requester`)),
        ...(await enqueueUserNotificationIntents(manager, target, {
          type: `assignment-swap-${nextStatus}`, title, message, eventType: record.eventType, eventId: record.eventId, urgency: 'important',
        }, `${idempotencyBase}:target`)),
      ];

      return { payload: nextPayload, result: nextStatus };
    });

    await deliverEnqueuedNotifications(db, enqueued);
    return NextResponse.json({ success: true, status });
  } catch (error) {
    if (error instanceof AssignmentSwapNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof AssignmentSwapConflictError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof AssignmentSwapValidationError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof PlanningValidationError) {
      return NextResponse.json({ error: error.message, blockers: error.details }, { status: 409 });
    }
    logError('app.unhandled', 'Admin assignment swap failed:', error);
    return NextResponse.json({ error: 'Impossible de valider cet échange' }, { status: 500 });
  }
}
