import type { DataSource, EntityManager } from 'typeorm';
import type { AssignmentContact } from '@/types/match';
import type {
  EntrainementEntity,
  MatchExtraEntity,
  PlateauEntity,
} from '@/lib/db/schemas';
import {
  parseEntrainementPayload,
  parseMatchExtrasPayload,
  parsePlateauPayload,
  serializeEntrainementPayload,
  serializeMatchExtrasPayload,
  serializePlateauPayload,
} from '@/lib/db/planning-payload-codecs';
import { anonymizeMessagesForDeletedUser } from '@/lib/chat/service';
import { ANONYMIZED_DISPLAY_NAME } from './constants';
import type { PlanningEventSnapshot, PlanningRole } from '@/lib/planning/event-store';

type Queryable = DataSource | EntityManager;

const ROLES: readonly PlanningRole[] = ['arbitre', 'encadrant', 'accompagnateur'];

function isEntityManager(db: Queryable): db is EntityManager {
  return 'queryRunner' in db && 'connection' in db;
}

export function anonymizeAssignmentContact(
  contact: AssignmentContact,
  personId: number,
): boolean {
  if (contact.personId !== personId) return false;
  let changed = false;
  if (contact.nom !== ANONYMIZED_DISPLAY_NAME) {
    contact.nom = ANONYMIZED_DISPLAY_NAME;
    changed = true;
  }
  if (contact.numero) {
    contact.numero = '';
    changed = true;
  }
  return changed;
}

export function anonymizeContactList(
  contacts: AssignmentContact[] | undefined,
  personId: number,
): boolean {
  if (!contacts?.length) return false;
  let changed = false;
  for (const contact of contacts) {
    if (anonymizeAssignmentContact(contact, personId)) changed = true;
  }
  return changed;
}

export function anonymizePlanningSnapshot(
  snapshot: PlanningEventSnapshot,
  personId: number,
): boolean {
  let changed = false;
  for (const role of ROLES) {
    if (anonymizeContactList(snapshot.assignments[role], personId)) changed = true;
  }
  if (snapshot.extras) {
    if (anonymizeContactList(snapshot.extras.arbitreTouche, personId)) changed = true;
    if (anonymizeContactList(snapshot.extras.contactEncadrants, personId)) changed = true;
    if (anonymizeContactList(snapshot.extras.contactAccompagnateur, personId)) changed = true;
  }
  if ('encadrants' in snapshot.event) {
    const event = snapshot.event as { encadrants?: AssignmentContact[] };
    if (anonymizeContactList(event.encadrants, personId)) changed = true;
  }
  return changed;
}

async function rewritePublishedJsonRecord(
  db: Queryable,
  recordId: string,
  clubId: string,
  personId: number,
): Promise<void> {
  const run = async (manager: EntityManager) => {
    const rows = (await manager.query(
      `SELECT payload FROM planning_records WHERE id = ? AND club_id = ? LIMIT 1 FOR UPDATE`,
      [recordId, clubId],
    )) as Array<{ payload: unknown }>;
    const row = rows[0];
    if (!row) return;

    let current: { schemaVersion?: number; events?: PlanningEventSnapshot[] };
    try {
      current = typeof row.payload === 'string'
        ? JSON.parse(row.payload) as { schemaVersion?: number; events?: PlanningEventSnapshot[] }
        : row.payload as { schemaVersion?: number; events?: PlanningEventSnapshot[] };
    } catch {
      return;
    }
    if (current?.schemaVersion !== 1 || !Array.isArray(current.events)) return;

    let changed = false;
    for (const snapshot of current.events) {
      if (anonymizePlanningSnapshot(snapshot, personId)) changed = true;
    }
    if (!changed) return;

    await manager.query(
      `UPDATE planning_records SET payload = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND club_id = ?`,
      [JSON.stringify(current), recordId, clubId],
    );
  };

  if (isEntityManager(db)) await run(db);
  else await db.transaction(run);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJsonPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function anonymizeNamedPerson(value: unknown, userId: number): boolean {
  const person = asRecord(value);
  if (!person) return false;
  if (person.userId !== userId && person.personId !== userId) return false;
  if (person.nom === ANONYMIZED_DISPLAY_NAME) return false;
  person.nom = ANONYMIZED_DISPLAY_NAME;
  return true;
}

export function anonymizeOperationalPayload(
  kind: string,
  payload: unknown,
  userId: number,
): { deleteRecord: boolean; payload: unknown; changed: boolean } {
  if (kind === 'notification-preferences' || kind === 'person-preference') {
    return { deleteRecord: true, payload, changed: true };
  }

  const record = asRecord(payload);
  if (!record) return { deleteRecord: false, payload, changed: false };

  let changed = false;
  if (record.authorUserId === userId && record.authorName !== ANONYMIZED_DISPLAY_NAME) {
    record.authorName = ANONYMIZED_DISPLAY_NAME;
    changed = true;
  }
  if (anonymizeNamedPerson(record.requester, userId)) changed = true;
  if (anonymizeNamedPerson(record.target, userId)) changed = true;
  return { deleteRecord: false, payload: record, changed };
}

export async function anonymizePersonEverywhere(
  db: Queryable,
  clubId: string,
  userId: number,
): Promise<{ authoredOperationalRecords: boolean }> {
  const extrasRepo = db.getRepository<MatchExtraEntity>('MatchExtra');
  const extras = await extrasRepo.findBy({ clubId });
  for (const row of extras) {
    const parsed = parseMatchExtrasPayload(row.payload, row.matchId);
    const changed = anonymizeContactList(parsed.arbitreTouche, userId)
      || anonymizeContactList(parsed.contactEncadrants, userId)
      || anonymizeContactList(parsed.contactAccompagnateur, userId);
    if (!changed) continue;
    row.payload = serializeMatchExtrasPayload(parsed);
    await extrasRepo.save(row);
  }

  const trainingRepo = db.getRepository<EntrainementEntity>('Entrainement');
  const trainings = await trainingRepo.findBy({ clubId });
  for (const row of trainings) {
    const event = parseEntrainementPayload(row.payload, row.id);
    if (!anonymizeContactList(event.encadrants, userId)) continue;
    row.payload = serializeEntrainementPayload(event);
    await trainingRepo.save(row);
  }

  const plateauRepo = db.getRepository<PlateauEntity>('Plateau');
  const plateaus = await plateauRepo.findBy({ clubId });
  for (const row of plateaus) {
    const event = parsePlateauPayload(row.payload, row.id);
    if (!anonymizeContactList(event.encadrants, userId)) continue;
    row.payload = serializePlateauPayload(event);
    await plateauRepo.save(row);
  }

  await rewritePublishedJsonRecord(db, `published-planning:${clubId}`, clubId, userId);
  await rewritePublishedJsonRecord(db, `published-planning-history:${clubId}`, clubId, userId);

  await db.query(
    `UPDATE planning_assignment_state SET person_name = ? WHERE club_id = ? AND person_id = ?`,
    [ANONYMIZED_DISPLAY_NAME, clubId, userId],
  );

  const recordRows = (await db.query(
    `SELECT id, kind, payload, owner_user_id AS ownerUserId, person_id AS personId
       FROM planning_records
      WHERE club_id = ?
        AND kind NOT IN ('published-planning', 'published-planning-history')
        AND (owner_user_id = ? OR person_id = ? OR kind IN ('comment', 'post-event-report', 'assignment-swap', 'task'))`,
    [clubId, userId, userId],
  )) as Array<{ id: string; kind: string; payload: unknown; ownerUserId: number | null; personId: number | null }>;

  let authoredOperationalRecords = false;
  for (const row of recordRows) {
    if (row.kind === 'notification-preferences' || row.kind === 'person-preference') {
      await db.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [row.id, clubId]);
      continue;
    }
    const owned = row.ownerUserId === userId || row.personId === userId;
    if (owned && (row.kind === 'comment' || row.kind === 'post-event-report' || row.kind === 'assignment-swap')) {
      authoredOperationalRecords = true;
    }
    const payload = parseJsonPayload(row.payload);
    const next = anonymizeOperationalPayload(row.kind, payload, userId);
    if (next.deleteRecord) {
      await db.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [row.id, clubId]);
      continue;
    }
    if (!next.changed) continue;
    authoredOperationalRecords = true;
    await db.query(
      `UPDATE planning_records SET payload = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND club_id = ?`,
      [JSON.stringify(next.payload), row.id, clubId],
    );
  }

  await anonymizeMessagesForDeletedUser(db, userId);
  return { authoredOperationalRecords };
}
