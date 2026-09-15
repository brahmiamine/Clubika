import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  canDeletePostEventReport,
  canReadPlanningEventWorkspace,
  canSubmitPostEventReport,
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
import { notifyAdmins } from '@/lib/notifications/service';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { readAppSettings } from '@/lib/settings-store';
import {
  isPostEventReportCategory,
  reportAuditAfter,
  reportDeletionAuditAfter,
  type PostEventReportCategory,
} from '@/lib/planning/report-privacy';
import { purgeExpiredPostEventReports } from '@/lib/planning/report-retention';

interface ReportPayload {
  category: PostEventReportCategory;
  text: string;
  authorUserId: number;
  authorName: string;
  authorRole: string;
  createdAt: string;
}

function validEventType(value: string): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

async function load(request: NextRequest, params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return { error: auth.error } as const;
  setCurrentClubId(auth.user.clubId);
  const resolved = params instanceof Promise ? await params : params;
  if (!validEventType(resolved.eventType) || !resolved.eventId) return { error: NextResponse.json({ error: 'Événement invalide' }, { status: 400 }) } as const;
  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'collaboration');
  if (disabled) return { error: disabled } as const;
  const personalScope = new URL(request.url).searchParams.get('scope') === 'personal';
  const accessUser = personalScope ? personalPlanningAccessUser(auth.user) : auth.user;
  if (!accessUser) return { error: NextResponse.json({ error: 'Compte personnel non lié' }, { status: 403 }) } as const;
  const snapshot = await resolvePlanningEventForAccess(db, accessUser, resolved.eventType, resolved.eventId);
  if (!snapshot) return { error: NextResponse.json({ error: 'Événement introuvable' }, { status: 404 }) } as const;
  if (!canReadPlanningEventWorkspace(accessUser, snapshot)) return { error: NextResponse.json({ error: 'Accès refusé' }, { status: 403 }) } as const;
  // Le contrôle « l'événement a commencé » utilise le fuseau horaire du club (issue #45).
  const { timeZone } = await readAppSettings(db, auth.user.clubId);
  return { auth, accessUser, db, snapshot, eventType: resolved.eventType, eventId: resolved.eventId, timeZone } as const;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } }) {
  const ctx = await load(request, params);
  if ('error' in ctx) return ctx.error;
  await purgeExpiredPostEventReports(ctx.db);
  const records = await listPlanningRecords<ReportPayload>(ctx.db, { kind: 'post-event-report', eventType: ctx.eventType, eventId: ctx.eventId }, 100);
  const reports = records.map((record) => ({
    ...record,
    canDelete: canDeletePostEventReport(ctx.auth.user, record),
  }));
  return NextResponse.json({ reports, canSubmit: canSubmitPostEventReport(ctx.accessUser, ctx.snapshot, Date.now(), ctx.timeZone) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } }) {
  const ctx = await load(request, params);
  if ('error' in ctx) return ctx.error;
  if (!canSubmitPostEventReport(ctx.accessUser, ctx.snapshot, Date.now(), ctx.timeZone)) {
    return NextResponse.json({ error: 'Le rapport est disponible après le début de l’événement pour les personnes affectées' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const category = isPostEventReportCategory(body.category) ? body.category : 'other';
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 5000) : '';
    if (!text) return NextResponse.json({ error: 'Rapport vide' }, { status: 400 });
    const id = planningRecordId('post-event-report');
    const payload: ReportPayload = {
      category,
      text,
      authorUserId: ctx.auth.user.id,
      authorName: ctx.auth.user.nom,
      authorRole: ctx.auth.user.accessRole,
      createdAt: new Date().toISOString(),
    };
    await savePlanningRecord(ctx.db, { id, kind: 'post-event-report', eventType: ctx.eventType, eventId: ctx.eventId, ownerUserId: ctx.auth.user.id, payload });
    const auditAfter = reportAuditAfter({
      reportId: id,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
      category,
    });
    await logAuditEntry(ctx.db, {
      user: ctx.auth.user,
      entityType: 'PlanningCollaboration',
      entityId: id,
      action: 'report',
      before: null,
      after: auditAfter,
    });
    await notifyAdmins(ctx.db, {
      type: 'post-event-report',
      title: 'Nouveau rapport post-événement',
      message: `${ctx.auth.user.nom} a déposé un rapport ${category} sur ${ctx.snapshot.title}.`,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
    });
    return NextResponse.json({ success: true, report: { id, payload } });
  } catch {
    return NextResponse.json({ error: 'Impossible d’enregistrer le rapport' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } }) {
  const ctx = await load(request, params);
  if ('error' in ctx) return ctx.error;
  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'Identifiant requis' }, { status: 400 });
  const record = await getPlanningRecord<ReportPayload>(ctx.db, id);
  if (!record || record.kind !== 'post-event-report' || record.eventType !== ctx.eventType || record.eventId !== ctx.eventId) {
    return NextResponse.json({ error: 'Rapport introuvable' }, { status: 404 });
  }
  if (!canDeletePostEventReport(ctx.auth.user, record)) {
    return NextResponse.json({ error: 'Suppression non autorisée' }, { status: 403 });
  }
  const category = isPostEventReportCategory(record.payload.category) ? record.payload.category : 'other';
  await deletePlanningRecord(ctx.db, id);
  await logAuditEntry(ctx.db, {
    user: ctx.auth.user,
    entityType: 'PlanningCollaboration',
    entityId: id,
    action: 'delete',
    before: reportAuditAfter({
      reportId: id,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
      category,
    }),
    after: reportDeletionAuditAfter('user'),
  });
  return NextResponse.json({ success: true });
}
