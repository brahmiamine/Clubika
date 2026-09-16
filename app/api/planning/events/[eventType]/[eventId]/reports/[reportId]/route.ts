import { NextRequest } from 'next/server';
import { logAuditEntry } from '@/lib/db/audit-log';
import { logError } from '@/lib/observability/log';
import { deletePlanningRecord, getPlanningRecord, savePlanningRecord } from '@/lib/planning/records';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import {
  REPORT_KIND,
  canDeleteReport,
  canReadReport,
  canUpdateReport,
  isReportCategory,
  toVisibleReport,
  type ReportPayload,
} from '@/lib/planning/report-access';
import { isPostEventReportCategory, reportAuditAfter, reportDeletionAuditAfter } from '@/lib/planning/report-privacy';
import { isReportRecordId, reportJson, reportNotFound } from '../context';

async function loadOwnedReport(
  request: NextRequest,
  params:
    | Promise<{ eventType: string; eventId: string; reportId: string }>
    | { eventType: string; eventId: string; reportId: string },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) return { error: auth.error } as const;
  setCurrentClubId(auth.user.clubId);
  const resolved = params instanceof Promise ? await params : params;
  if (!resolved.eventType || !resolved.eventId || !isReportRecordId(resolved.reportId)) {
    return { error: reportNotFound() } as const;
  }
  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'collaboration');
  if (disabled) return { error: disabled } as const;
  const record = await getPlanningRecord<ReportPayload>(db, resolved.reportId);
  if (
    !record
    || record.kind !== REPORT_KIND
    || record.eventType !== resolved.eventType
    || record.eventId !== resolved.eventId
    || record.clubId !== auth.user.clubId
  ) {
    return { error: reportNotFound() } as const;
  }
  return { auth, db, record, eventType: resolved.eventType, eventId: resolved.eventId } as const;
}

export async function GET(
  request: NextRequest,
  { params }: {
    params: Promise<{ eventType: string; eventId: string; reportId: string }> | { eventType: string; eventId: string; reportId: string };
  },
) {
  const ctx = await loadOwnedReport(request, params);
  if ('error' in ctx) return ctx.error;
  if (!canReadReport(ctx.auth.user, ctx.record)) return reportNotFound();
  return reportJson({ report: toVisibleReport(ctx.auth.user, ctx.record) });
}

export async function PATCH(
  request: NextRequest,
  { params }: {
    params: Promise<{ eventType: string; eventId: string; reportId: string }> | { eventType: string; eventId: string; reportId: string };
  },
) {
  const ctx = await loadOwnedReport(request, params);
  if ('error' in ctx) return ctx.error;
  if (!canUpdateReport(ctx.auth.user, ctx.record)) return reportNotFound();

  try {
    const body = await request.json();
    const category = isReportCategory(body.category) ? body.category : ctx.record.payload.category;
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 5000) : ctx.record.payload.text;
    if (!text) return reportJson({ error: 'Rapport vide' }, 400);
    const payload: ReportPayload = {
      category,
      text,
      authorUserId: ctx.record.payload.authorUserId,
      authorName: ctx.record.payload.authorName,
      authorRole: ctx.record.payload.authorRole,
      createdAt: ctx.record.payload.createdAt,
    };
    await savePlanningRecord(ctx.db, {
      id: ctx.record.id,
      kind: REPORT_KIND,
      eventType: ctx.record.eventType,
      eventId: ctx.record.eventId,
      ownerUserId: ctx.record.ownerUserId,
      payload,
    });
    const auditCategory = isPostEventReportCategory(payload.category) ? payload.category : 'other';
    const auditMeta = reportAuditAfter({
      reportId: ctx.record.id,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
      category: auditCategory,
    });
    await logAuditEntry(ctx.db, {
      user: ctx.auth.user,
      entityType: 'PlanningCollaboration',
      entityId: ctx.record.id,
      action: 'update',
      before: auditMeta,
      after: auditMeta,
    });
    return reportJson({
      success: true,
      report: toVisibleReport(ctx.auth.user, { ...ctx.record, payload }),
    });
  } catch (error) {
    logError('app.unhandled', 'Post-event report update failed', error);
    return reportJson({ error: 'Impossible de modifier le rapport' }, 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: {
    params: Promise<{ eventType: string; eventId: string; reportId: string }> | { eventType: string; eventId: string; reportId: string };
  },
) {
  const ctx = await loadOwnedReport(request, params);
  if ('error' in ctx) return ctx.error;
  if (!canDeleteReport(ctx.auth.user, ctx.record)) return reportNotFound();

  const deleted = await deletePlanningRecord(ctx.db, ctx.record.id);
  if (!deleted) return reportNotFound();
  const category = isPostEventReportCategory(ctx.record.payload.category)
    ? ctx.record.payload.category
    : 'other';
  await logAuditEntry(ctx.db, {
    user: ctx.auth.user,
    entityType: 'PlanningCollaboration',
    entityId: ctx.record.id,
    action: 'delete',
    before: reportAuditAfter({
      reportId: ctx.record.id,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
      category,
    }),
    after: reportDeletionAuditAfter('user'),
  });
  return reportJson({ success: true });
}
