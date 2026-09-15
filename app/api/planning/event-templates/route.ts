import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import {
  deletePlanningRecord,
  getPlanningRecord,
  listPlanningRecords,
  planningRecordId,
  savePlanningRecord,
} from '@/lib/planning/records';
import { setCurrentClubId } from '@/lib/auth/club-context';

type TemplateEventType = 'amical' | 'entrainement' | 'plateau';

interface EventTemplatePayload {
  name: string;
  eventType: TemplateEventType;
  fields: Record<string, unknown>;
}

const TEMPLATE_EVENT_TYPES: TemplateEventType[] = ['amical', 'entrainement', 'plateau'];

// Champs acceptés par field, par type — un modèle ne porte jamais de date/heure ni de
// statut de publication : ces routes de création les régénèrent systématiquement.
const TEMPLATE_FIELDS: Record<TemplateEventType, string[]> = {
  amical: ['localTeam', 'awayTeam', 'competition', 'categorie', 'venue', 'horaireRendezVous', 'details', 'staff', 'durationMinutes'],
  entrainement: ['lieu', 'categorie', 'durationMinutes', 'encadrants'],
  plateau: ['lieu', 'categories', 'durationMinutes', 'encadrants'],
};

function sanitizeFields(eventType: TemplateEventType, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const allowed = TEMPLATE_FIELDS[eventType];
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in raw) result[key] = raw[key];
  }
  return result;
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const db = await getDb();
  const records = await listPlanningRecords<EventTemplatePayload>(db, { kind: 'event-template' }, 200);
  return NextResponse.json({
    templates: records.map((record) => ({
      id: record.id,
      name: record.payload.name,
      eventType: record.payload.eventType,
      fields: record.payload.fields,
      createdAt: record.createdAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    const eventType = TEMPLATE_EVENT_TYPES.includes(body.eventType) ? body.eventType as TemplateEventType : null;
    if (!name || !eventType) {
      return NextResponse.json({ error: 'Nom et type d’événement requis' }, { status: 400 });
    }
    const fields = sanitizeFields(eventType, body.fields);

    const id = planningRecordId('event-template');
    const db = await getDb();
    await savePlanningRecord<EventTemplatePayload>(db, {
      id,
      kind: 'event-template',
      ownerUserId: auth.user.id,
      payload: { name, eventType, fields },
    });

    return NextResponse.json({ success: true, template: { id, name, eventType, fields } });
  } catch (error) {
    logError('app.unhandled', 'Saving event template failed:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer ce modèle' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id?.startsWith('event-template:')) {
    return NextResponse.json({ error: 'Modèle invalide' }, { status: 400 });
  }

  const db = await getDb();
  const record = await getPlanningRecord<EventTemplatePayload>(db, id);
  if (!record) {
    return NextResponse.json({ error: 'Modèle introuvable' }, { status: 404 });
  }
  await deletePlanningRecord(db, id);
  return NextResponse.json({ success: true });
}
