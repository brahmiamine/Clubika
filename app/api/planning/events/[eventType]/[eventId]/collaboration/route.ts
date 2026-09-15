import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  canCommentOnPlanningEvent,
  canManagePlanningEventWorkspace,
  canReadPlanningEventWorkspace,
  personalPlanningAccessUser,
  resolvePlanningEventForAccess,
} from '@/lib/planning/event-access';
import type { PlanningEventType } from '@/lib/planning/event-store';
import {
  deletePlanningRecord,
  getPlanningRecord,
  listPlanningRecords,
  planningRecordId,
  savePlanningRecord,
} from '@/lib/planning/records';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';

interface CommentPayload {
  text: string;
  authorUserId: number;
  authorName: string;
  createdAt: string;
}

interface TaskPayload {
  label: string;
  description: string | null;
  assigneeUserId: number | null;
  assigneePersonType: string | null;
  assigneePersonId: number | null;
  dueAt: string | null;
  completedAt: string | null;
  completedByUserId: number | null;
  createdByUserId: number;
}

function validEventType(value: string): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

async function context(request: NextRequest, params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return { error: auth.error } as const;
  setCurrentClubId(auth.user.clubId);
  const resolved = params instanceof Promise ? await params : params;
  if (!validEventType(resolved.eventType) || !resolved.eventId) {
    return { error: NextResponse.json({ error: 'Événement invalide' }, { status: 400 }) } as const;
  }
  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'collaboration');
  if (disabled) return { error: disabled } as const;
  const personalScope = new URL(request.url).searchParams.get('scope') === 'personal';
  const accessUser = personalScope ? personalPlanningAccessUser(auth.user) : auth.user;
  if (!accessUser) return { error: NextResponse.json({ error: 'Compte personnel non lié' }, { status: 403 }) } as const;
  const snapshot = await resolvePlanningEventForAccess(db, accessUser, resolved.eventType, resolved.eventId);
  if (!snapshot) return { error: NextResponse.json({ error: 'Événement introuvable' }, { status: 404 }) } as const;
  if (!canReadPlanningEventWorkspace(accessUser, snapshot)) {
    return { error: NextResponse.json({ error: 'Accès refusé' }, { status: 403 }) } as const;
  }
  return { auth, accessUser, db, snapshot, eventType: resolved.eventType, eventId: resolved.eventId } as const;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await context(request, params);
  if ('error' in ctx) return ctx.error;
  const [comments, tasks] = await Promise.all([
    listPlanningRecords<CommentPayload>(ctx.db, { kind: 'comment', eventType: ctx.eventType, eventId: ctx.eventId }, 250),
    listPlanningRecords<TaskPayload>(ctx.db, { kind: 'task', eventType: ctx.eventType, eventId: ctx.eventId }, 250),
  ]);
  return NextResponse.json({ comments, tasks, canManage: canManagePlanningEventWorkspace(ctx.accessUser) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await context(request, params);
  if ('error' in ctx) return ctx.error;

  try {
    const body = await request.json();
    if (body.kind === 'comment') {
      if (!canCommentOnPlanningEvent(ctx.accessUser, ctx.snapshot)) {
        return NextResponse.json({ error: 'Commentaire non autorisé' }, { status: 403 });
      }
      const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
      if (!text) return NextResponse.json({ error: 'Commentaire vide' }, { status: 400 });
      const id = planningRecordId('comment');
      const payload: CommentPayload = { text, authorUserId: ctx.auth.user.id, authorName: ctx.auth.user.nom, createdAt: new Date().toISOString() };
      await savePlanningRecord(ctx.db, { id, kind: 'comment', eventType: ctx.eventType, eventId: ctx.eventId, ownerUserId: ctx.auth.user.id, payload });
      await logAuditEntry(ctx.db, { user: ctx.auth.user, entityType: 'PlanningCollaboration', entityId: id, action: 'create', before: null, after: payload as unknown as Record<string, unknown> });
      return NextResponse.json({ success: true, item: { id, payload } });
    }

    if (body.kind === 'task') {
      if (!canManagePlanningEventWorkspace(ctx.accessUser)) {
        return NextResponse.json({ error: 'Création de tâche réservée aux administrateurs' }, { status: 403 });
      }
      const label = typeof body.label === 'string' ? body.label.trim().slice(0, 200) : '';
      if (!label) return NextResponse.json({ error: 'Libellé de tâche requis' }, { status: 400 });
      const dueAt = typeof body.dueAt === 'string' && !Number.isNaN(Date.parse(body.dueAt)) ? new Date(body.dueAt).toISOString() : null;
      const payload: TaskPayload = {
        label,
        description: typeof body.description === 'string' ? body.description.trim().slice(0, 1000) || null : null,
        assigneeUserId: Number.isInteger(Number(body.assigneeUserId)) ? Number(body.assigneeUserId) : null,
        assigneePersonType: typeof body.assigneePersonType === 'string' ? body.assigneePersonType : null,
        assigneePersonId: Number.isInteger(Number(body.assigneePersonId)) ? Number(body.assigneePersonId) : null,
        dueAt,
        completedAt: null,
        completedByUserId: null,
        createdByUserId: ctx.auth.user.id,
      };
      const id = planningRecordId('task');
      await savePlanningRecord(ctx.db, { id, kind: 'task', eventType: ctx.eventType, eventId: ctx.eventId, ownerUserId: ctx.auth.user.id, personType: payload.assigneePersonType, personId: payload.assigneePersonId, payload });
      await logAuditEntry(ctx.db, { user: ctx.auth.user, entityType: 'PlanningCollaboration', entityId: id, action: 'create', before: null, after: payload as unknown as Record<string, unknown> });
      return NextResponse.json({ success: true, item: { id, payload } });
    }

    return NextResponse.json({ error: 'Type de collaboration invalide' }, { status: 400 });
  } catch (error) {
    logError('app.unhandled', 'Event collaboration write failed:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer la collaboration' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await context(request, params);
  if ('error' in ctx) return ctx.error;
  const body = await request.json();
  const id = typeof body.id === 'string' ? body.id : '';
  const record = id ? await getPlanningRecord<TaskPayload>(ctx.db, id) : null;
  if (!record || record.kind !== 'task' || record.eventType !== ctx.eventType || record.eventId !== ctx.eventId) {
    return NextResponse.json({ error: 'Tâche introuvable' }, { status: 404 });
  }
  const isAssignee = record.payload.assigneeUserId === ctx.auth.user.id
    || record.payload.assigneePersonId === ctx.auth.user.id;
  if (!canManagePlanningEventWorkspace(ctx.accessUser) && !isAssignee) {
    return NextResponse.json({ error: 'Modification de tâche non autorisée' }, { status: 403 });
  }
  const complete = body.completed === true;
  const payload: TaskPayload = {
    ...record.payload,
    completedAt: complete ? new Date().toISOString() : null,
    completedByUserId: complete ? ctx.auth.user.id : null,
  };
  await savePlanningRecord(ctx.db, { id, kind: 'task', eventType: ctx.eventType, eventId: ctx.eventId, ownerUserId: record.ownerUserId, personType: record.personType, personId: record.personId, payload });
  await logAuditEntry(ctx.db, { user: ctx.auth.user, entityType: 'PlanningCollaboration', entityId: id, action: complete ? 'complete' : 'update', before: record.payload as unknown as Record<string, unknown>, after: payload as unknown as Record<string, unknown> });
  return NextResponse.json({ success: true, item: { ...record, payload } });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await context(request, params);
  if ('error' in ctx) return ctx.error;
  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'Identifiant requis' }, { status: 400 });
  const record = await getPlanningRecord(ctx.db, id);
  if (!record || record.eventType !== ctx.eventType || record.eventId !== ctx.eventId) {
    return NextResponse.json({ error: 'Élément introuvable' }, { status: 404 });
  }
  const ownsComment = record.kind === 'comment' && record.ownerUserId === ctx.auth.user.id;
  if (!canManagePlanningEventWorkspace(ctx.accessUser) && !ownsComment) {
    return NextResponse.json({ error: 'Suppression non autorisée' }, { status: 403 });
  }
  await deletePlanningRecord(ctx.db, id);
  await logAuditEntry(ctx.db, { user: ctx.auth.user, entityType: 'PlanningCollaboration', entityId: id, action: 'delete', before: record.payload as Record<string, unknown>, after: null });
  return NextResponse.json({ success: true });
}
