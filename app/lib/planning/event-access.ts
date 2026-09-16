import type { DataSource, EntityManager } from 'typeorm';
import type { SessionUser } from '@/lib/auth/session';
import { canEdit, hasAnyPlanningFunction } from '@/lib/auth/roles';
import { getCurrentClubId } from '@/lib/auth/club-context';
import type { UserEntity } from '@/lib/db/schemas';
import { personIdentityMatches } from './person-link';
import { getPlanningEventSnapshot, type PlanningEventSnapshot, type PlanningEventType, type PlanningRole } from './event-store';
import { assignmentStatus, eventStartTimestamp, isVisiblePublicationStatus } from './p0-rules';
import { listPublishedPlanningEventSnapshots } from './published-planning';
import { hydratePlanningAssignmentStates } from './assignment-state-overlay';

type Queryable = DataSource | EntityManager;

const ASSIGNMENT_ROLES: PlanningRole[] = ['arbitre', 'encadrant', 'accompagnateur'];

/**
 * Identifiants des comptes ayant **accepté** l'affectation sur le snapshot publié.
 * Une personne est reconnue par `personId` ou par nom normalisé, comme pour Mon Planning.
 * Les affectations en attente ou refusées n'ouvrent pas le chat d'événement.
 */
export async function assignedUserIdsForPlanningEvent(
  db: Queryable,
  snapshot: PlanningEventSnapshot,
  activeUsers?: readonly UserEntity[],
): Promise<number[]> {
  const users = activeUsers ?? await db.getRepository<UserEntity>('User').find({
    where: { active: true, clubId: getCurrentClubId() },
  });
  return assignedUserIdsFromSnapshot(snapshot, users);
}

/** Version synchrone pour éviter un N+1 quand les utilisateurs actifs sont déjà chargés (issue #390). */
export function assignedUserIdsFromSnapshot(
  snapshot: PlanningEventSnapshot,
  activeUsers: readonly UserEntity[],
): number[] {
  const ids = new Set<number>();
  for (const role of ASSIGNMENT_ROLES) {
    for (const contact of snapshot.assignments[role] ?? []) {
      if (assignmentStatus(contact) !== 'accepted') continue;
      if (contact.personId !== undefined && contact.personType) {
        if (activeUsers.some((user) => user.id === contact.personId)) ids.add(contact.personId);
        continue;
      }
      const name = contact.nom.trim().toLowerCase();
      if (!name) continue;
      for (const user of activeUsers) {
        if (user.nom.trim().toLowerCase() === name) ids.add(user.id);
      }
    }
  }
  return Array.from(ids);
}

export function buildAssignedUserIdsByEventKey(
  snapshots: readonly PlanningEventSnapshot[],
  activeUsers: readonly UserEntity[],
): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const snapshot of snapshots) {
    map.set(
      `${snapshot.eventType}:${snapshot.eventId}`,
      assignedUserIdsFromSnapshot(snapshot, activeUsers),
    );
  }
  return map;
}

/** Snapshot publié d'un événement, avec états opérationnels superposés. */
export async function resolvePublishedEventSnapshot(
  db: Queryable,
  clubId: string,
  eventType: PlanningEventType,
  eventId: string,
): Promise<PlanningEventSnapshot | null> {
  const published = await listPublishedPlanningEventSnapshots(db);
  if (!published) return null;
  const match = published.find((snapshot) => snapshot.eventType === eventType && snapshot.eventId === eventId);
  if (!match) return null;
  return (await hydratePlanningAssignmentStates(db, [match], clubId))[0] ?? null;
}

export function isPlanningAdmin(user: SessionUser): boolean {
  return canEdit(user.accessRole);
}

/**
 * Dans l'espace personnel, un administrateur qui tient aussi des fonctions terrain doit
 * être évalué comme un simple dirigeant afin de lire le snapshot publié et non le
 * brouillon admin. Les fonctions, elles, restent inchangées.
 */
export function personalPlanningAccessUser(user: SessionUser): SessionUser | null {
  if (!hasAnyPlanningFunction(user.planningFunctions)) return null;
  return { ...user, accessRole: 'dirigeant' };
}

export function isAssignedToPlanningEvent(user: SessionUser, snapshot: PlanningEventSnapshot): boolean {
  if (!hasAnyPlanningFunction(user.planningFunctions)) return false;
  return Object.values(snapshot.assignments).some((contacts) =>
    contacts.some((contact) => personIdentityMatches(contact, user)),
  );
}

export function canReadPlanningEventWorkspace(user: SessionUser, snapshot: PlanningEventSnapshot): boolean {
  if (isPlanningAdmin(user)) return true;
  // Un événement annulé reste accessible en lecture aux personnes affectées (issue #80) :
  // l'annulation est précisément un moment où l'historique du chat, les consignes et les
  // pièces jointes peuvent être utiles. Seules les actions sont bloquées (réponses déjà
  // refusées côté route, commentaires via canCommentOnPlanningEvent ci-dessous).
  const readable = isVisiblePublicationStatus(snapshot.planningStatus)
    || snapshot.planningStatus === 'cancelled';
  return readable && isAssignedToPlanningEvent(user, snapshot);
}

export function canCommentOnPlanningEvent(user: SessionUser, snapshot: PlanningEventSnapshot): boolean {
  if (isPlanningAdmin(user)) return true;
  // Commenter reste réservé aux événements visibles : pas de nouvelle discussion sur un
  // événement annulé — la lecture de l'existant reste permise par canReadPlanningEventWorkspace.
  return isVisiblePublicationStatus(snapshot.planningStatus) && isAssignedToPlanningEvent(user, snapshot);
}

export function canDeletePostEventReport(
  user: SessionUser,
  record: { ownerUserId: number | null },
): boolean {
  if (isPlanningAdmin(user)) return true;
  return record.ownerUserId === user.id;
}

export function canSubmitPostEventReport(
  user: SessionUser,
  snapshot: PlanningEventSnapshot,
  now = Date.now(),
  /** Fuseau horaire du club pour le contrôle du début d'événement (issue #45). */
  timeZone = 'UTC',
): boolean {
  if (isPlanningAdmin(user)) return true;
  if (!isAssignedToPlanningEvent(user, snapshot)) return false;
  const start = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
  return start !== null && start <= now;
}

export function canManagePlanningEventWorkspace(user: SessionUser): boolean {
  return isPlanningAdmin(user);
}

/**
 * Résout l'événement à utiliser pour vérifier l'accès d'un compte personnel aux
 * sous-fonctionnalités (collaboration, rapports, pièces jointes, météo) : ces comptes
 * ne doivent jamais voir leur accès dépendre du brouillon de travail de l'admin, qui peut
 * diverger du planning publié tant qu'il n'a pas été republié. Un admin continue de
 * travailler sur la copie live. `listPublishedPlanningEventSnapshots` renvoie `null` aussi
 * bien quand le club n'a encore jamais publié de planning global que si le snapshot stocké
 * est illisible (payload corrompu) : dans les deux cas un compte personnel ne doit rien voir,
 * jamais de repli sur le brouillon live qui n'a encore jamais été validé (issue #94).
 */
export async function resolvePlanningEventForAccess(
  db: Queryable,
  user: SessionUser,
  eventType: PlanningEventType,
  eventId: string,
): Promise<PlanningEventSnapshot | null> {
  if (isPlanningAdmin(user)) {
    return getPlanningEventSnapshot(db, eventType, eventId);
  }
  const publishedSnapshots = await listPublishedPlanningEventSnapshots(db);
  if (!publishedSnapshots) return null;
  const published = publishedSnapshots.find((snapshot) => snapshot.eventType === eventType && snapshot.eventId === eventId);
  if (!published) return null;
  return (await hydratePlanningAssignmentStates(db, [published], user.clubId))[0] ?? null;
}
