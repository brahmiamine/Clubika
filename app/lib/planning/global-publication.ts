import type { DataSource } from 'typeorm';
import type { SessionUser } from '@/lib/auth/session';
import type { UserEntity } from '@/lib/db/schemas';
import { logAuditEntry } from '@/lib/db/audit-log';
import { deliverEnqueuedNotifications, enqueueContactNotificationIntents } from '@/lib/notifications/service';
import {
  listPlanningEventSnapshots,
  savePlanningPublication,
  type PlanningEventSnapshot,
  type PlanningRole,
} from './event-store';
import {
  assessPublicationReadiness,
  PlanningValidationError,
  validateAssignmentSet,
} from './validation';
import { readAppSettings } from '@/lib/settings-store';
import type { AppSettings } from '@/lib/settings';
import { getCurrentClubId } from '@/lib/auth/club-context';
import {
  appendPublishedPlanningHistory,
  applyReconfirmationResets,
  computePerUserPublicationChanges,
  eventKey,
  getPublishedPlanning,
  isWithinPublicationWindow,
  planningPublicationDiff,
  publicationWindowStart,
  savePublishedPlanning,
  type PlanningPublicationDiff,
  type PublicationChangeKind,
  type ReconfirmationReset,
} from './published-planning';
import { hydratePlanningAssignmentStates } from './assignment-state-overlay';
import { syncAssignmentStatesForRole } from './assignment-state-store';
import { functionForPlanningRole, userHoldsFunction } from './person-link';
import { activeContacts } from './p0-rules';
import { vacateDeclinedAssignmentsFromWorkingDraft } from './declined-assignment-draft';
import { filterOfficialEventsForDisplay } from './official-match-visibility';

const CHANGE_TITLES: Record<PublicationChangeKind, string> = {
  added: 'Nouvelle affectation',
  removed: 'Affectation supprimée',
  rescheduled: 'Horaire modifié',
  cancelled: 'Événement annulé',
};

// Issue #217 : une annulation d'événement ou un retrait d'affectation sont les seuls
// changements réellement critiques pour la personne concernée — les seuls qui doivent
// franchir le seuil « Critiques uniquement » sur les canaux secondaires (push/email/WhatsApp).
const CRITICAL_CHANGE_KINDS: ReadonlySet<PublicationChangeKind> = new Set(['cancelled', 'removed']);

function contactIdentity(contact: { personId?: number; personType?: string; nom: string }): string {
  return contact.personId !== undefined && contact.personType
    ? `${contact.personType}:${contact.personId}`
    : contact.nom.trim().toLowerCase();
}

function resetKey(reset: ReconfirmationReset): string {
  // Une personne qui change de rôle reste affectée au même événement : le dédoublonnage
  // ne doit pas dépendre du rôle, sinon elle reçoit aussi une fausse notification "supprimée".
  return `${reset.eventType}:${reset.eventId}:${contactIdentity(reset.contact)}`;
}

function rolesFor(snapshot: PlanningEventSnapshot): PlanningRole[] {
  return snapshot.eventType === 'officiel' || snapshot.eventType === 'amical'
    ? ['arbitre', 'encadrant', 'accompagnateur']
    : ['encadrant'];
}

export interface PublicationBlocker {
  code: string;
  /** Message complet « Titre — détail » (compat affichage liste). */
  message: string;
  /** Événement concerné, pour afficher le blocage directement sur sa carte. */
  eventType: PlanningEventSnapshot['eventType'];
  eventId: string;
  /** Partie actionnable du message, sans le préfixe du titre. */
  detail: string;
}

/**
 * Points bloquants d'une publication globale (postes requis manquants, conflits de
 * validation) pour un lot de candidats déjà filtré (non annulés, dans la fenêtre) et
 * hydraté. Fonction pure : partagée entre l'aperçu (`getGlobalPlanningPublicationPreview`,
 * affichage proactif) et la publication (`publishGlobalPlanning`, garde-fou).
 * N'inclut pas la validation d'approbation admin, propre à l'action de publier.
 */
export function collectPublicationBlockers(
  candidates: PlanningEventSnapshot[],
  settings: AppSettings,
  users: Array<Pick<UserEntity, 'id' | 'nom' | 'planningFunctions' | 'indisponibilites' | 'active'>>,
): PublicationBlocker[] {
  const blockers: PublicationBlocker[] = [];

  // Issue #206 : un compte désactivé après avoir été affecté ne doit jamais publier
  // silencieusement — toujours signalé, indépendamment des fonctionnalités optionnelles
  // de lecture/validation ci-dessous. Issue #273 : un `personId` ne correspondant plus à
  // AUCUN compte (compte supprimé) doit être signalé au même titre, et non pas seulement
  // quand `assignmentValidation` est activée — sinon une publication peut figer
  // silencieusement une référence orpheline dans le snapshot publié.
  const usersById = new Map(users.map((user) => [user.id, user]));
  for (const snapshot of candidates) {
    for (const role of rolesFor(snapshot)) {
      for (const contact of activeContacts(snapshot.assignments[role])) {
        if (contact.personId === undefined) continue;
        const person = usersById.get(contact.personId);
        if (!person) {
          const detail = `${contact.nom} n'existe plus dans le référentiel`;
          blockers.push({
            code: `${snapshot.eventType}:${snapshot.eventId}:${role}:unknown-assignee`,
            message: `${snapshot.title} — ${detail}`,
            eventType: snapshot.eventType,
            eventId: snapshot.eventId,
            detail,
          });
          continue;
        }
        if (!person.active) {
          const detail = `${contact.nom} n'est plus un compte actif`;
          blockers.push({
            code: `${snapshot.eventType}:${snapshot.eventId}:${role}:inactive-assignee`,
            message: `${snapshot.title} — ${detail}`,
            eventType: snapshot.eventType,
            eventId: snapshot.eventId,
            detail,
          });
        }
      }
    }
  }

  if (settings.features.publicationReadiness) {
    const requirements = {
      arbitre: settings.features.requireArbitreForPublication,
      encadrant: settings.features.requireEncadrantForPublication,
      accompagnateur: settings.features.requireAccompagnateurForPublication,
    };
    for (const snapshot of candidates) {
      const readiness = assessPublicationReadiness(snapshot, requirements);
      for (const blocker of readiness.blockers) {
        blockers.push({
          code: `${snapshot.eventType}:${snapshot.eventId}:${blocker.code}`,
          message: `${snapshot.title} — ${blocker.message}`,
          eventType: snapshot.eventType,
          eventId: snapshot.eventId,
          detail: blocker.message,
        });
      }
    }
  }

  if (settings.features.assignmentValidation) {
    const validationSnapshots = candidates.map((snapshot) => ({ ...snapshot, planningStatus: 'published' as const }));
    for (const snapshot of candidates) {
      for (const role of rolesFor(snapshot)) {
        const people = users
          .filter((candidate) => userHoldsFunction(candidate, functionForPlanningRole(role)))
          .map((candidate) => ({
            id: candidate.id,
            nom: candidate.nom,
            indisponibilites: candidate.indisponibilites ?? [],
          }));
        const violations = validateAssignmentSet({
          target: { ...snapshot, planningStatus: 'published' },
          role,
          contacts: snapshot.assignments[role],
          people,
          snapshots: validationSnapshots,
        });
        for (const violation of violations) {
          blockers.push({
            code: `${snapshot.eventType}:${snapshot.eventId}:${role}:${violation.code}`,
            message: `${snapshot.title} — ${violation.message}`,
            eventType: snapshot.eventType,
            eventId: snapshot.eventId,
            detail: violation.message,
          });
        }
      }
    }
  }

  return blockers;
}

export interface GlobalPlanningPublicationPreview {
  lastPublishedAt: string | null;
  diff: PlanningPublicationDiff;
  /** Points bloquants actuels (affichés avant toute tentative de publication). */
  blockers: PublicationBlocker[];
}

export async function getGlobalPlanningPublicationPreview(
  db: DataSource,
): Promise<GlobalPlanningPublicationPreview> {
  const clubId = getCurrentClubId();
  try {
    await vacateDeclinedAssignmentsFromWorkingDraft(db, clubId);
  } catch (error) {
    console.error('Impossible d’aligner le brouillon sur les refus d’affectation:', error);
  }
  const [currentRaw, published, settings, users] = await Promise.all([
    listPlanningEventSnapshots(db),
    getPublishedPlanning(db),
    readAppSettings(db, clubId),
    db.getRepository<UserEntity>('User').find({ where: { clubId } }),
  ]);
  // L'aperçu reflète exactement ce que la publication fera : seuls les événements dans
  // la fenêtre de publication sont candidats, les plus anciens partent en historique (issue #42).
  const windowStart = publicationWindowStart(Date.now(), settings.timeZone);
  const current = filterOfficialEventsForDisplay(currentRaw, settings);
  const publishedEvents = filterOfficialEventsForDisplay(published?.events ?? [], settings);
  const currentInWindow = current.filter((snapshot) => isWithinPublicationWindow(snapshot, windowStart, settings.timeZone));
  const blockerCandidates = await hydratePlanningAssignmentStates(
    db,
    currentInWindow.filter((snapshot) => snapshot.planningStatus !== 'cancelled'),
    clubId,
  );
  return {
    lastPublishedAt: published?.publishedAt ?? null,
    diff: planningPublicationDiff(currentInWindow, publishedEvents),
    blockers: collectPublicationBlockers(blockerCandidates, settings, users),
  };
}

export async function publishGlobalPlanning(
  db: DataSource,
  user: SessionUser,
): Promise<GlobalPlanningPublicationPreview> {
  try {
    await vacateDeclinedAssignmentsFromWorkingDraft(db, user.clubId);
  } catch (error) {
    console.error('Impossible d’aligner le brouillon sur les refus d’affectation:', error);
  }
  const settings = await readAppSettings(db, user.clubId);
  const beforeRaw = await getPublishedPlanning(db);
  const currentRaw = await listPlanningEventSnapshots(db);
  const [currentHydrated, previousHydrated] = await Promise.all([
    hydratePlanningAssignmentStates(db, currentRaw, user.clubId),
    hydratePlanningAssignmentStates(db, beforeRaw?.events ?? [], user.clubId),
  ]);
  const current = filterOfficialEventsForDisplay(currentHydrated, settings);
  const previousEvents = filterOfficialEventsForDisplay(previousHydrated, settings);
  const before = beforeRaw ? { ...beforeRaw, events: previousEvents } : null;

  // Fenêtre de publication (issue #42) : seuls les événements de J-7 (00:00 heure du club)
  // au futur sont validés et publiés. Les événements plus anciens sont versés dans
  // l'historique dédié et ne peuvent jamais bloquer une publication future.
  const windowStart = publicationWindowStart(Date.now(), settings.timeZone);
  const inWindow = (snapshot: PlanningEventSnapshot) =>
    isWithinPublicationWindow(snapshot, windowStart, settings.timeZone);
  const candidates = current.filter((snapshot) => snapshot.planningStatus !== 'cancelled' && inWindow(snapshot));

  const users = await db.getRepository<UserEntity>('User').find({ where: { clubId: user.clubId } });
  const blockers = collectPublicationBlockers(candidates, settings, users);

  if (blockers.length) {
    throw new PlanningValidationError(
      'Le planning contient des éléments à corriger avant publication.',
      blockers,
    );
  }

  // Une affectation déjà acceptée/refusée sur la publication précédente ne doit jamais être
  // reconduite telle quelle si les conditions matérielles de l'événement (date, heure, lieu,
  // horaire de rendez-vous) ou le rôle de la personne ont changé depuis : on la remet à `pending`
  // avant d'écrire ce nouveau candidat, et on retient qui doit être notifié pour reconfirmer.
  const publishedAt = new Date().toISOString();
  const beforeByKey = new Map((before?.events ?? []).map((snapshot) => [eventKey(snapshot), snapshot]));
  const allResets: ReconfirmationReset[] = [];
  const stateWrites = new Map<string, PlanningEventSnapshot['assignments'][PlanningRole]>();
  const candidatesToPublish = candidates.map((candidate) => {
    const previous = beforeByKey.get(eventKey(candidate));
    const { snapshot, resets } = applyReconfirmationResets(previous, candidate, publishedAt);
    allResets.push(...resets);
    const resetPeople = new Set(resets.map((reset) => `${reset.role}:${contactIdentity(reset.contact)}`));
    for (const role of rolesFor(snapshot)) {
      const previousPeople = new Set(previous?.assignments[role].map(contactIdentity) ?? []);
      const intentional = snapshot.assignments[role].filter((contact) =>
        !previousPeople.has(contactIdentity(contact))
        || resetPeople.has(`${role}:${contactIdentity(contact)}`));
      if (intentional.length) stateWrites.set(`${eventKey(snapshot)}:${role}`, intentional);
    }
    return snapshot;
  });

  // Toutes les écritures (statuts par événement + snapshot global) dans une seule
  // transaction DB : soit le nouveau planning complet devient visible, soit rien ne
  // change. Une erreur sur un seul événement (concurrence, contrainte DB, etc.) fait
  // échouer et annule l'ensemble — jamais de publication partielle.
  // Les événements annulés déjà communiqués restent dans le snapshot publié avec le statut
  // `cancelled` afin de ne pas disparaître silencieusement du planning utilisateur, tant
  // qu'ils restent dans la fenêtre de publication ; au-delà ils rejoignent l'historique.
  const previouslyPublishedKeys = new Set((before?.events ?? []).map(eventKey));

  const { payload, diff, enqueuedNotifications } = await db.transaction(async (manager) => {
    for (const snapshot of candidatesToPublish) {
      const patch: Record<string, unknown> = {
        planningStatus: 'published',
        publishedAt,
        publishedByUserId: user.id,
        modifiedAfterPublishAt: null,
        cancelledAt: null,
        cancelledByUserId: null,
        cancellationReason: null,
      };
      if (snapshot.eventType === 'officiel' || snapshot.eventType === 'amical') {
        patch.arbitreTouche = snapshot.assignments.arbitre;
        patch.contactEncadrants = snapshot.assignments.encadrant;
        patch.contactAccompagnateur = snapshot.assignments.accompagnateur;
      } else {
        patch.encadrants = snapshot.assignments.encadrant;
      }
      await savePlanningPublication(manager, snapshot, patch);
      for (const role of rolesFor(snapshot)) {
        const intentional = stateWrites.get(`${eventKey(snapshot)}:${role}`);
        if (intentional) {
          await syncAssignmentStatesForRole(
            manager,
            snapshot.eventType,
            snapshot.eventId,
            role,
            intentional,
            user.clubId,
          );
        }
      }
    }

    const refreshedInTx = filterOfficialEventsForDisplay(await listPlanningEventSnapshots(manager), settings);
    // Le snapshot publié actif ne porte que la fenêtre : sa taille reste maîtrisée.
    const publishable = refreshedInTx.filter(inWindow);
    const publishedPayload = await savePublishedPlanning(
      manager,
      user,
      publishable,
      publishedAt,
      previouslyPublishedKeys,
    );

    // Les événements précédemment publiés qui sortent de la fenêtre ne disparaissent pas :
    // ils sont conservés dans l'historique publié dédié.
    const publishableKeys = new Set(publishable.map(eventKey));
    const agedOut = (before?.events ?? []).filter((snapshot) => !publishableKeys.has(eventKey(snapshot)));
    if (agedOut.length) {
      await appendPublishedPlanningHistory(manager, user, agedOut);
    }

    const diffInTx = planningPublicationDiff(refreshedInTx.filter(inWindow), before?.events ?? []);

    // Issue #276 : l'entrée d'audit et les intentions de notification (ligne in-app +
    // lignes d'outbox par canal) sont écrites avec le même `manager`, donc dans la même
    // transaction que le snapshot publié — soit tout est acté ensemble, soit rien ne
    // l'est. Seule la livraison réseau réelle (push/email/whatsapp) reste hors
    // transaction, après le commit (cf. `deliverEnqueuedNotifications` plus bas).
    await logAuditEntry(manager, {
      user,
      entityType: 'PlanningPublication',
      entityId: 'global',
      action: 'publish',
      before: before ? {
        publishedAt: before.publishedAt,
        events: before.events.length,
      } : null,
      after: {
        publishedAt: publishedPayload.publishedAt,
        events: publishedPayload.events.length,
        diff: diffInTx,
      },
    });

    // Empreinte d'idempotence ancrée sur le dernier état publié AVANT cette tentative
    // (plutôt que sur `publishedAt`, propre à cette tentative) : deux publications
    // concurrentes parties du même `before` calculent la même clé pour un même
    // changement et convergent sur les mêmes lignes d'outbox au lieu de doubler la
    // notification (issue #276).
    const idempotencyBase = `publish:${before?.publishedAt ?? 'initial'}`;

    // Un message générique unique enverrait "Planning publié" même à quelqu'un dont rien
    // n'a changé, et ne dirait jamais à une personne retirée qu'elle l'a été. Chaque
    // changement structurel réel donne lieu à un message ciblé ; personne n'est notifié
    // pour un événement qu'elle continue de voir à l'identique.
    //
    // Un contact remis à `pending` par `applyReconfirmationResets` reçoit un message dédié
    // "merci de reconfirmer" plutôt que le message générique "horaire modifié" : on retire
    // ces cas du diff générique pour éviter une double notification sur le même événement.
    //
    // Les événements sortis de la fenêtre de publication sont versés dans l'historique en
    // silence : ils sont exclus du diff de notification pour éviter de fausses notifications
    // « Affectation supprimée » sur des événements passés (issue #76).
    //
    // Issue #348 : une republication sans changement (diff vide / identique au dernier
    // snapshot publié) ne doit jamais ré-enfiler de notifications.
    let enqueuedChanges: Awaited<ReturnType<typeof enqueueContactNotificationIntents>> = [];
    let enqueuedResets: Awaited<ReturnType<typeof enqueueContactNotificationIntents>> = [];
    if (diffInTx.changed > 0) {
      const resetKeysInTx = new Set(allResets.map((reset) => resetKey(reset)));
      const notifiedBefore = (before?.events ?? []).filter((snapshot) => inWindow(snapshot));
      const changes = computePerUserPublicationChanges(notifiedBefore, publishedPayload.events, refreshedInTx)
        .filter((change) => !resetKeysInTx.has(`${change.eventType}:${change.eventId}:${contactIdentity(change.contact)}`));

      enqueuedChanges = (await Promise.all(changes.map((change) => enqueueContactNotificationIntents(
        manager,
        change.contact,
        {
          type: `planning-published-${change.kind}`,
          title: CHANGE_TITLES[change.kind],
          message: change.message,
          eventType: change.eventType,
          eventId: change.eventId,
          urgency: CRITICAL_CHANGE_KINDS.has(change.kind) ? 'critical' : 'normal',
        },
        `${idempotencyBase}:${change.eventType}:${change.eventId}:${contactIdentity(change.contact)}:${change.kind}`,
      )))).flat();

      const candidateByKey = new Map(candidatesToPublish.map((snapshot) => [eventKey(snapshot), snapshot]));
      enqueuedResets = (await Promise.all(allResets.map((reset) => {
        const snapshot = candidateByKey.get(`${reset.eventType}:${reset.eventId}`);
        return enqueueContactNotificationIntents(
          manager,
          reset.contact,
          {
            type: 'planning-published-reconfirmation-required',
            title: 'Confirmation requise',
            message: snapshot
              ? `Le planning a changé pour ${snapshot.title} (${snapshot.date} ${snapshot.time}) : merci de confirmer à nouveau votre présence.`
              : 'Le planning a changé : merci de confirmer à nouveau votre présence.',
            eventType: reset.eventType,
            eventId: reset.eventId,
          },
          `${idempotencyBase}:reconfirm:${reset.eventType}:${reset.eventId}:${contactIdentity(reset.contact)}`,
        );
      }))).flat();
    }

    return {
      payload: publishedPayload,
      diff: diffInTx,
      enqueuedNotifications: [...enqueuedChanges, ...enqueuedResets],
    };
  });

  // Livraison différée après le commit (issue #276 : non-but explicite que d'envoyer
  // push/email dans la transaction) — un échec réseau reste isolé de la publication déjà
  // actée et rejouable via l'outbox existant (`retryPendingNotifications`), jamais une
  // cause d'échec de la commande de publication elle-même.
  await deliverEnqueuedNotifications(db, enqueuedNotifications);

  return {
    lastPublishedAt: payload.publishedAt,
    diff,
    blockers: [],
  };
}
