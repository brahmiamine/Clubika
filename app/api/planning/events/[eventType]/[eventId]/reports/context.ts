import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import {
  canReadPlanningEventWorkspace,
  canSubmitPostEventReport,
  personalPlanningAccessUser,
  resolvePlanningEventForAccess,
} from '@/lib/planning/event-access';
import type { PlanningEventType } from '@/lib/planning/event-store';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';
import { REPORT_KIND } from '@/lib/planning/report-access';

const NO_STORE = { 'Cache-Control': 'private, no-store, max-age=0' };

export function reportJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function reportNotFound(): NextResponse {
  return reportJson({ error: 'Not found' }, 404);
}

function validEventType(value: string): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

export async function loadReportCollection(
  request: NextRequest,
  params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) return { error: auth.error } as const;
  setCurrentClubId(auth.user.clubId);
  const resolved = params instanceof Promise ? await params : params;
  if (!validEventType(resolved.eventType) || !resolved.eventId) {
    return { error: reportJson({ error: 'Événement invalide' }, 400) } as const;
  }
  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'collaboration');
  if (disabled) return { error: disabled } as const;
  const personalScope = new URL(request.url).searchParams.get('scope') === 'personal';
  const accessUser = personalScope ? personalPlanningAccessUser(auth.user) : auth.user;
  if (!accessUser) return { error: reportNotFound() } as const;
  const snapshot = await resolvePlanningEventForAccess(db, accessUser, resolved.eventType, resolved.eventId);
  if (!snapshot) return { error: reportNotFound() } as const;
  if (!canReadPlanningEventWorkspace(accessUser, snapshot)) return { error: reportNotFound() } as const;
  const { timeZone } = await readAppSettings(db, auth.user.clubId);
  return {
    auth,
    accessUser,
    db,
    snapshot,
    eventType: resolved.eventType,
    eventId: resolved.eventId,
    timeZone,
    canSubmit: canSubmitPostEventReport(accessUser, snapshot, Date.now(), timeZone),
  } as const;
}

export function isReportRecordId(id: string): boolean {
  return id.startsWith(`${REPORT_KIND}:`);
}
