import type { DataSource, EntityManager } from 'typeorm';
import type { AssignmentContact } from '@/types/match';
import { listPlanningEventSnapshots, type PlanningRole } from './event-store';
import { getPublishedPlanning, getPublishedPlanningHistory } from './published-planning';
import { listPlanningRecords } from './records';

type Queryable = DataSource | EntityManager;

const ROLES: readonly PlanningRole[] = ['arbitre', 'encadrant', 'accompagnateur'];

interface AssignmentBearing {
  assignments: Record<PlanningRole, AssignmentContact[]>;
}

function referencesPerson(snapshots: readonly AssignmentBearing[], personId: number): boolean {
  return snapshots.some((snapshot) =>
    ROLES.some((role) => (snapshot.assignments[role] ?? []).some((contact) => contact.personId === personId)));
}

export interface UserReferenceReport {
  referenced: boolean;
  /** Raisons lisibles, pour un message d'erreur actionnable côté UI. */
  reasons: string[];
}

/**
 * Détecte toute référence métier à un utilisateur — brouillon, planning publié,
 * historique de publication, autre enregistrement de planning le ciblant (échange
 * d'affectation, disponibilité, commentaire…), participation à une conversation de
 * chat (issue #273). Un compte référencé n'est plus un obstacle à la fermeture :
 * l'identité est anonymisée en place (issue #11) et un stub technique conserve les
 * clés étrangères. La désactivation (`active = false`) reste disponible sans
 * effacement d'identité.
 *
 * Nécessite `setCurrentClubId` déjà positionné (ambiant, comme
 * `listPlanningEventSnapshots`).
 */
export async function findUserReferences(
  db: Queryable,
  clubId: string,
  personId: number,
): Promise<UserReferenceReport> {
  const reasons: string[] = [];

  const [draft, published, history, recordsAsPerson, recordsAsOwner, chatParticipation] = await Promise.all([
    listPlanningEventSnapshots(db),
    getPublishedPlanning(db, clubId),
    getPublishedPlanningHistory(db, clubId),
    listPlanningRecords(db, { clubId, personId }, 1),
    listPlanningRecords(db, { clubId, ownerUserId: personId }, 1),
    db.getRepository('ChatParticipant').findOneBy({ userId: personId }),
  ]);

  if (referencesPerson(draft, personId)) reasons.push('affecté à un événement du planning (brouillon)');
  if (published && referencesPerson(published.events, personId)) reasons.push('affecté à un événement du planning publié');
  if (history && referencesPerson(history.events, personId)) reasons.push('affecté à un événement de l\'historique de publication');
  if (recordsAsPerson.length > 0 || recordsAsOwner.length > 0) {
    reasons.push('référencé par un autre enregistrement de planning (échange, disponibilité, commentaire…)');
  }
  if (chatParticipation) reasons.push('participe à une conversation de chat');

  return { referenced: reasons.length > 0, reasons };
}
