import { NextRequest } from 'next/server';
import { logAuditEntry } from '@/lib/db/audit-log';
import { listPlanningRecords, planningRecordId, savePlanningRecord } from '@/lib/planning/records';
import { notifyAdmins } from '@/lib/notifications/service';
import {
  REPORT_AVAILABLE_NOTICE,
  REPORT_KIND,
  filterVisibleReports,
  isReportCategory,
  paginateReports,
  parseReportPage,
  reportAuditMeta,
  toVisibleReport,
  type ReportPayload,
} from '@/lib/planning/report-access';
import { loadReportCollection, reportJson } from './context';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await loadReportCollection(request, params);
  if ('error' in ctx) return ctx.error;
  const { limit, offset } = parseReportPage(new URL(request.url).searchParams);
  const stored = await listPlanningRecords<ReportPayload>(
    ctx.db,
    { kind: REPORT_KIND, eventType: ctx.eventType, eventId: ctx.eventId },
    1000,
  );
  const visible = filterVisibleReports(ctx.accessUser, stored);
  const page = paginateReports(visible, limit, offset);
  return reportJson({
    reports: page.reports,
    canSubmit: ctx.canSubmit,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await loadReportCollection(request, params);
  if ('error' in ctx) return ctx.error;
  if (!ctx.canSubmit) {
    return reportJson({ error: 'Action non autorisée' }, 403);
  }

  try {
    const body = await request.json();
    const category = isReportCategory(body.category) ? body.category : 'other';
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 5000) : '';
    if (!text) return reportJson({ error: 'Rapport vide' }, 400);
    const id = planningRecordId(REPORT_KIND);
    const payload: ReportPayload = {
      category,
      text,
      authorUserId: ctx.auth.user.id,
      authorName: ctx.auth.user.nom,
      authorRole: ctx.auth.user.accessRole,
      createdAt: new Date().toISOString(),
    };
    await savePlanningRecord(ctx.db, {
      id,
      kind: REPORT_KIND,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
      ownerUserId: ctx.auth.user.id,
      payload,
    });
    await logAuditEntry(ctx.db, {
      user: ctx.auth.user,
      entityType: 'PlanningCollaboration',
      entityId: id,
      action: 'report',
      before: null,
      after: reportAuditMeta(id),
    });
    await notifyAdmins(ctx.db, {
      type: 'post-event-report',
      title: REPORT_AVAILABLE_NOTICE,
      message: REPORT_AVAILABLE_NOTICE,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
    });
    const stored = {
      id,
      clubId: ctx.auth.user.clubId,
      kind: REPORT_KIND,
      eventType: ctx.eventType,
      eventId: ctx.eventId,
      ownerUserId: ctx.auth.user.id,
      personType: null,
      personId: null,
      tokenHash: null,
      payload,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return reportJson({ success: true, report: toVisibleReport(ctx.accessUser, stored) });
  } catch {
    console.error('Post-event report failed');
    return reportJson({ error: 'Impossible d’enregistrer le rapport' }, 500);
  }
}
