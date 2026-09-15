import type { DataSource, EntityManager } from 'typeorm';
import type {
  AssignmentContact,
  AssignmentStatus,
  AttendanceStatus,
  DeclineReason,
  ReminderStage,
} from '@/types/match';
import { getCurrentClubId } from '@/lib/auth/club-context';
import { assignmentStatus } from './p0-rules';
import type { PlanningEventSnapshot, PlanningEventType, PlanningRole } from './event-store';
import { sanitizeAssignmentOperationalFields } from '@/lib/privacy/health-data';

type Queryable = DataSource | EntityManager;

/**
 * État opérationnel d'une affectation publiée (issue #41), stocké hors du brouillon live.
 *
 * Le snapshot publié fournit la structure (qui est affecté, où, quand) ; ce store porte
 * l'état vécu (réponse, motif de refus, relances, présence), indexé par une clé stable
 * `clubId + eventType + eventId + role + personKey` qui survit aux ré-importations du
 * scraper et aux éditions du brouillon — cause racine évoquée dans #26.
 *
 * Ce store est l'unique source de vérité des réponses, relances et présences. Les
 * snapshots live/publiés ne sont que la structure ; les lecteurs hydratent celle-ci avec
 * ces lignes. Les éditions du brouillon et le scraper ne touchent jamais à ce store.
 */

export interface AssignmentOperationalState {
  status: AssignmentStatus;
  assignedAt?: string;
  respondedAt?: string;
  declineReason?: DeclineReason;
  declineComment?: string;
  remindersSent: ReminderStage[];
  lastReminderAt?: string;
  reminderCount: number;
  attendanceStatus?: AttendanceStatus;
  attendanceUpdatedAt?: string;
}

export interface AssignmentStateRow {
  clubId: string;
  eventType: PlanningEventType;
  eventId: string;
  role: PlanningRole;
  personKey: string;
  personType: string | null;
  personId: number | null;
  personName: string;
  state: AssignmentOperationalState;
  updatedAt: Date;
}

function defaultClubId(): string {
  return getCurrentClubId();
}

function normalizePersonName(nom: string): string {
  return nom.trim().toLowerCase();
}

/**
 * Clé stable d'une personne affectée : l'identifiant de compte quand il est connu,
 * sinon le nom normalisé (repli documenté : risque de collision entre homonymes
 * saisis à la main, assumé tant que le contact n'est pas rattaché à un compte).
 */
export function assignmentStatePersonKey(contact: Pick<AssignmentContact, 'nom' | 'personId' | 'personType'>): string {
  if (contact.personId !== undefined && contact.personId !== null && contact.personType) {
    return `id:${contact.personType}:${contact.personId}`;
  }
  return `nom:${normalizePersonName(contact.nom)}`;
}

/** Extrait l'état opérationnel d'un contact de snapshot (champs structurels exclus). */
export function operationalStateFromContact(contact: AssignmentContact): AssignmentOperationalState {
  const sanitized = sanitizeAssignmentOperationalFields(contact);
  return {
    status: assignmentStatus(contact),
    assignedAt: contact.assignedAt,
    respondedAt: contact.respondedAt,
    declineReason: sanitized.declineReason,
    remindersSent: contact.remindersSent ?? [],
    lastReminderAt: contact.lastReminderAt,
    reminderCount: contact.reminderCount ?? 0,
    attendanceStatus: contact.attendanceStatus,
    attendanceUpdatedAt: contact.attendanceUpdatedAt,
  };
}

/**
 * Ré-applique un état opérationnel du store sur un contact structurel (lecture, étape 2) :
 * les champs d'identité (nom, numéro, personId/personType) viennent toujours du snapshot.
 */
export function applyOperationalStateToContact(
  contact: AssignmentContact,
  state: AssignmentOperationalState,
): AssignmentContact {
  const sanitized = sanitizeAssignmentOperationalFields({
    ...contact,
    declineReason: state.declineReason,
    declineComment: state.declineComment,
  });
  const next: AssignmentContact = {
    ...contact,
    status: state.status,
    assignedAt: state.assignedAt ?? contact.assignedAt,
    respondedAt: state.respondedAt,
    declineReason: sanitized.declineReason,
    remindersSent: state.remindersSent,
    lastReminderAt: state.lastReminderAt,
    reminderCount: state.reminderCount,
    attendanceStatus: state.attendanceStatus,
    attendanceUpdatedAt: state.attendanceUpdatedAt,
  };
  delete next.declineComment;
  return next;
}

interface UpsertRow {
  personKey: string;
  personType: string | null;
  personId: number | null;
  personName: string;
  state: AssignmentOperationalState;
}

function toUpsertRow(contact: AssignmentContact): UpsertRow {
  return {
    personKey: assignmentStatePersonKey(contact),
    personType: contact.personType ?? null,
    personId: contact.personId ?? null,
    personName: contact.nom,
    state: operationalStateFromContact(contact),
  };
}

async function upsertAssignmentStates(
  db: Queryable,
  clubId: string,
  eventType: PlanningEventType,
  eventId: string,
  role: PlanningRole,
  contacts: AssignmentContact[],
): Promise<void> {
  for (const contact of contacts) {
    const row = toUpsertRow(contact);
    await db.query(
      `INSERT INTO planning_assignment_state
        (club_id, event_type, event_id, role, person_key, person_type, person_id, person_name, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
        person_type = VALUES(person_type), person_id = VALUES(person_id), person_name = VALUES(person_name),
        state = VALUES(state), updated_at = CURRENT_TIMESTAMP(6)`,
      [
        clubId,
        eventType,
        eventId,
        role,
        row.personKey,
        row.personType,
        row.personId,
        row.personName,
        JSON.stringify(row.state),
      ],
    );
  }
}

function isManager(db: Queryable): db is EntityManager {
  return 'queryRunner' in db && 'connection' in db;
}

/**
 * Met à jour uniquement les compteurs de relance si l'affectation est encore pending.
 * Le verrou de ligne empêche une relance calculée sur un snapshot ancien d'écraser une
 * réponse acceptée/refusée arrivée en parallèle.
 */
export async function updateAssignmentReminderStateIfPending(
  db: Queryable,
  eventType: PlanningEventType,
  eventId: string,
  role: PlanningRole,
  contact: AssignmentContact,
  clubId = defaultClubId(),
): Promise<boolean> {
  const work = async (manager: EntityManager): Promise<boolean> => {
    const personKey = assignmentStatePersonKey(contact);
    const rows = (await manager.query(
      `${STATE_SELECT} WHERE club_id = ? AND event_type = ? AND event_id = ? AND role = ? AND person_key = ? FOR UPDATE`,
      [clubId, eventType, eventId, role, personKey],
    )) as Record<string, unknown>[];
    const current = rows[0] ? mapStateRow(rows[0]).state : null;
    if (!current || current.status !== 'pending') return false;
    const next: AssignmentOperationalState = {
      ...current,
      remindersSent: contact.remindersSent ?? current.remindersSent,
      lastReminderAt: contact.lastReminderAt,
      reminderCount: contact.reminderCount ?? current.reminderCount,
    };
    await manager.query(
      `UPDATE planning_assignment_state SET state = ?, updated_at = CURRENT_TIMESTAMP(6)
       WHERE club_id = ? AND event_type = ? AND event_id = ? AND role = ? AND person_key = ?`,
      [JSON.stringify(next), clubId, eventType, eventId, role, personKey],
    );
    return true;
  };
  return isManager(db) ? work(db) : db.transaction(work);
}

async function insertAssignmentStatesIfMissing(
  db: Queryable,
  clubId: string,
  eventType: PlanningEventType,
  eventId: string,
  role: PlanningRole,
  contacts: AssignmentContact[],
): Promise<void> {
  for (const contact of contacts) {
    const row = toUpsertRow(contact);
    await db.query(
      `INSERT IGNORE INTO planning_assignment_state
        (club_id, event_type, event_id, role, person_key, person_type, person_id, person_name, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        clubId,
        eventType,
        eventId,
        role,
        row.personKey,
        row.personType,
        row.personId,
        row.personName,
        JSON.stringify(row.state),
      ],
    );
  }
}

const ASSIGNMENT_STATE_ROLES: PlanningRole[] = ['arbitre', 'encadrant', 'accompagnateur'];

/**
 * Persiste l'état opérationnel des contacts fournis. Peut recevoir un seul contact afin
 * de ne jamais écraser une réponse concurrente portée par une autre ligne.
 *
 * Ne supprime jamais de ligne : un contact retiré du brouillon garde son état, qui reste
 * rattaché à la version publiée tant que celle-ci le porte.
 */
export async function syncAssignmentStatesForRole(
  db: Queryable,
  eventType: PlanningEventType,
  eventId: string,
  role: PlanningRole,
  contacts: AssignmentContact[],
  clubId = defaultClubId(),
): Promise<void> {
  await upsertAssignmentStates(db, clubId, eventType, eventId, role, contacts);
}

function mapStateRow(row: Record<string, unknown>): AssignmentStateRow {
  let state: AssignmentOperationalState;
  try {
    state = JSON.parse(String(row.state ?? '{}')) as AssignmentOperationalState;
  } catch {
    state = { status: 'pending', remindersSent: [], reminderCount: 0 };
  }
  return {
    clubId: String(row.clubId),
    eventType: String(row.eventType) as PlanningEventType,
    eventId: String(row.eventId),
    role: String(row.role) as PlanningRole,
    personKey: String(row.personKey),
    personType: row.personType === null || row.personType === undefined ? null : String(row.personType),
    personId: row.personId === null || row.personId === undefined ? null : Number(row.personId),
    personName: String(row.personName ?? ''),
    state,
    updatedAt: new Date(String(row.updatedAt)),
  };
}

const STATE_SELECT = `SELECT club_id AS clubId, event_type AS eventType, event_id AS eventId, role,
       person_key AS personKey, person_type AS personType, person_id AS personId,
       person_name AS personName, state, updated_at AS updatedAt
  FROM planning_assignment_state`;

/** Liste l'état opérationnel connu pour un événement (tous rôles confondus). */
export async function listAssignmentStatesForEvent(
  db: Queryable,
  eventType: PlanningEventType,
  eventId: string,
  clubId = defaultClubId(),
): Promise<AssignmentStateRow[]> {
  const rows = (await db.query(
    `${STATE_SELECT} WHERE club_id = ? AND event_type = ? AND event_id = ?`,
    [clubId, eventType, eventId],
  )) as Record<string, unknown>[];
  return rows.map(mapStateRow);
}

/**
 * Variante par lot pour les lectures qui superposent l'état sur plusieurs événements
 * (étape 2 : overlay publié, mon-planning, iCal) — une seule requête au lieu d'une par
 * événement.
 */
export async function listAssignmentStatesForEvents(
  db: Queryable,
  keys: { eventType: PlanningEventType; eventId: string }[],
  clubId?: string,
): Promise<AssignmentStateRow[]> {
  if (keys.length === 0) return [];
  const scopedClubId = clubId ?? defaultClubId();
  const unique = [...new Map(keys.map((key) => [`${key.eventType}:${key.eventId}`, key])).values()];
  const clauses = unique.map(() => '(event_type = ? AND event_id = ?)').join(' OR ');
  const params = unique.flatMap((key) => [key.eventType, key.eventId]);
  const rows = (await db.query(
    `${STATE_SELECT} WHERE club_id = ? AND (${clauses})`,
    [scopedClubId, ...params],
  )) as Record<string, unknown>[];
  return rows.map(mapStateRow);
}

/**
 * Rétro-remplissage (étape 1) : alimente le store depuis des snapshots existants sans
 * jamais écraser une ligne déjà présente (INSERT IGNORE) — une ligne écrite par le
 * dual-write est au moins aussi fraîche que ce qu'un snapshot relu plus tard contient.
 *
 * `sources` doit être ordonné par autorité décroissante : les snapshots live d'abord
 * (toutes les écritures opérationnelles historiques y ont abouti), puis le snapshot
 * publié, puis l'historique publié. À clé identique, la première source rencontrée gagne.
 */
export async function backfillAssignmentStatesFromSnapshots(
  db: Queryable,
  sources: PlanningEventSnapshot[],
  clubId = defaultClubId(),
): Promise<number> {
  let written = 0;
  const seen = new Set<string>();
  for (const snapshot of sources) {
    for (const role of ASSIGNMENT_STATE_ROLES) {
      const contacts = snapshot.assignments[role] ?? [];
      const fresh = contacts.filter((contact) => {
        const key = `${snapshot.eventType}:${snapshot.eventId}:${role}:${assignmentStatePersonKey(contact)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (fresh.length === 0) continue;
      await insertAssignmentStatesIfMissing(db, clubId, snapshot.eventType, snapshot.eventId, role, fresh);
      written += fresh.length;
    }
  }
  return written;
}
