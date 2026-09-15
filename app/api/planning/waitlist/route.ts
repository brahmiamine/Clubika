import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import { buildAssignmentSuggestions } from '@/lib/planning/assignment-suggestions';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { findAssignablePerson } from '@/lib/planning/person-link';
import {
  getPlanningEventSnapshot,
  savePlanningPublication,
  saveRoleAssignments,
  type PlanningEventType,
  type PlanningRole,
} from '@/lib/planning/event-store';
import {
  deletePlanningRecord,
  listPlanningRecords,
  savePlanningRecord,
} from '@/lib/planning/records';
import type { PersonType } from '@/types/match';
import { isPlanningEventCurrentlyPublished } from '@/lib/planning/event-lifecycle';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { PlanningValidationError } from '@/lib/planning/validation';

interface WaitlistPayload {
  role: PlanningRole;
  personType: PersonType;
  personId: number;
  nom: string;
  telephone: string | null;
  rank: number;
  addedAt: string;
}

function validEventType(value: unknown): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function validRole(value: unknown): value is PlanningRole {
  return value === 'arbitre' || value === 'encadrant' || value === 'accompagnateur';
}

function personTypeForRole(role: PlanningRole): PersonType {
  if (role === 'arbitre') return 'officiel';
  if (role === 'encadrant') return 'encadrant';
  return 'accompagnateur';
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const url = new URL(request.url);
  const eventType = url.searchParams.get('eventType');
  const eventId = url.searchParams.get('eventId')?.trim();
  const role = url.searchParams.get('role');
  if (!eventId || !validEventType(eventType) || !validRole(role)) {
    return NextResponse.json({ error: 'Filtre de liste d’attente invalide' }, { status: 400 });
  }
  const db = await getDb();
  const records = await listPlanningRecords<WaitlistPayload>(db, { kind: 'waitlist', eventType, eventId }, 100);
  const items = records.filter((record) => record.payload.role === role).sort((a, b) => a.payload.rank - b.payload.rank);
  return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const action = body.action === 'promote' ? 'promote' : 'add';
    const db = await getDb();

    if (action === 'promote') {
      const recordId = typeof body.recordId === 'string' ? body.recordId : '';
      const records = await listPlanningRecords<WaitlistPayload>(db, { kind: 'waitlist' }, 1000);
      const record = records.find((item) => item.id === recordId);
      if (!record || !record.eventType || !record.eventId) {
        return NextResponse.json({ error: 'Candidat de remplacement introuvable' }, { status: 404 });
      }
      if (!validEventType(record.eventType) || !validRole(record.payload.role)) {
        return NextResponse.json({ error: 'Liste d’attente invalide' }, { status: 409 });
      }
      const eventType = record.eventType;
      const eventId = record.eventId;

      const snapshot = await getPlanningEventSnapshot(db, eventType, eventId);
      if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });
      const suggestions = await buildAssignmentSuggestions(db, snapshot, record.payload.role, 20);
      const candidate = suggestions.find((item) => item.personId === record.payload.personId && item.personType === record.payload.personType);
      if (!candidate) {
        return NextResponse.json({ error: 'Ce candidat n’est plus disponible ou présente un conflit' }, { status: 409 });
      }

      const before = snapshot.assignments[record.payload.role];
      const next = await enrichAssignmentContacts(db, auth.user.clubId, [
        ...before,
        {
          nom: candidate.nom,
          numero: candidate.telephone ?? '',
          personId: candidate.personId,
          personType: candidate.personType,
          status: 'pending',
          assignedAt: new Date().toISOString(),
        },
      ], candidate.personType, before);
      let publicationRequired = false;
      const modifiedAt = new Date().toISOString();

      // La promotion est une modification de préparation : affectation + retrait de la
      // waitlist forment une seule transaction. Aucune notification n'est envoyée ici,
      // car la personne ne voit l'affectation qu'après la publication globale.
      await db.transaction(async (manager) => {
        publicationRequired = await isPlanningEventCurrentlyPublished(
          manager,
          auth.user.clubId,
          eventType,
          eventId,
        );
        await saveRoleAssignments(manager, snapshot, record.payload.role, next);

        if (publicationRequired) {
          const refreshed = await getPlanningEventSnapshot(manager, eventType, eventId);
          if (!refreshed) throw new Error('Événement introuvable après promotion');
          await savePlanningPublication(manager, refreshed, {
            planningStatus: 'modified',
            modifiedAfterPublishAt: modifiedAt,
          });
        }

        const deleted = await deletePlanningRecord(manager, record.id);
        if (!deleted) throw new Error('La liste d’attente a changé pendant la promotion');
      });

      await logAuditEntry(db, {
        user: auth.user,
        entityType: 'PlanningAssignment',
        entityId: `${eventType}:${eventId}:${record.payload.role}`,
        action: 'auto-assign',
        before: { waitlist: record.payload, contacts: before },
        after: { promoted: candidate, contacts: next, publicationRequired },
      });
      return NextResponse.json({ success: true, promoted: candidate, publicationRequired });
    }

    const eventType = body.eventType;
    const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : '';
    const role = body.role;
    const personId = Number(body.personId);
    if (!eventId || !validEventType(eventType) || !validRole(role) || !Number.isInteger(personId) || personId <= 0) {
      return NextResponse.json({ error: 'Candidat de liste d’attente invalide' }, { status: 400 });
    }
    const expectedPersonType = personTypeForRole(role);
    const person = await findAssignablePerson(db, auth.user.clubId, expectedPersonType, { personId });
    if (!person) return NextResponse.json({ error: 'Personne introuvable' }, { status: 404 });
    const snapshot = await getPlanningEventSnapshot(db, eventType, eventId);
    if (!snapshot) return NextResponse.json({ error: 'Événement introuvable' }, { status: 404 });

    const existing = await listPlanningRecords<WaitlistPayload>(db, { kind: 'waitlist', eventType, eventId }, 100);
    const sameRole = existing.filter((record) => record.payload.role === role);
    const id = `waitlist:${eventType}:${eventId}:${role}:${expectedPersonType}:${personId}`;
    const payload: WaitlistPayload = {
      role,
      personType: expectedPersonType,
      personId,
      nom: person.nom,
      telephone: person.telephone,
      rank: sameRole.length + 1,
      addedAt: new Date().toISOString(),
    };
    await savePlanningRecord(db, { id, kind: 'waitlist', eventType, eventId, personType: expectedPersonType, personId, payload });
    return NextResponse.json({ success: true, item: { id, ...payload } });
  } catch (error) {
    if (error instanceof PlanningValidationError) {
      return NextResponse.json({ error: error.message, blockers: error.details }, { status: 409 });
    }
    logError('app.unhandled', 'Planning waitlist failed:', error);
    return NextResponse.json({ error: 'Impossible de modifier la liste d’attente' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'Identifiant requis' }, { status: 400 });
  const db = await getDb();
  const deleted = await deletePlanningRecord(db, id);
  return deleted
    ? NextResponse.json({ success: true })
    : NextResponse.json({ error: 'Candidat introuvable' }, { status: 404 });
}
