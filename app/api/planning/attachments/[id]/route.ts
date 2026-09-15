import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  canManagePlanningEventWorkspace,
  canReadPlanningEventWorkspace,
  personalPlanningAccessUser,
  resolvePlanningEventForAccess,
} from '@/lib/planning/event-access';
import type { PlanningEventType } from '@/lib/planning/event-store';
import { deletePlanningAttachment, getPlanningAttachment } from '@/lib/planning/records';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { attachmentDownloadHeaders } from '@/lib/security/attachment-headers';

function validEventType(value: string): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

async function load(request: NextRequest, params: Promise<{ id: string }> | { id: string }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return { error: auth.error } as const;
  setCurrentClubId(auth.user.clubId);
  const { id } = params instanceof Promise ? await params : params;
  const db = await getDb();
  const attachment = await getPlanningAttachment(db, id);
  if (!attachment || !validEventType(attachment.eventType)) {
    return { error: NextResponse.json({ error: 'Document introuvable' }, { status: 404 }) } as const;
  }
  const personalScope = new URL(request.url).searchParams.get('scope') === 'personal';
  const accessUser = personalScope ? personalPlanningAccessUser(auth.user) : auth.user;
  if (!accessUser) return { error: NextResponse.json({ error: 'Compte personnel non lié' }, { status: 403 }) } as const;
  const snapshot = await resolvePlanningEventForAccess(db, accessUser, attachment.eventType, attachment.eventId);
  if (!snapshot) return { error: NextResponse.json({ error: 'Événement introuvable' }, { status: 404 }) } as const;
  if (!canReadPlanningEventWorkspace(accessUser, snapshot)) {
    return { error: NextResponse.json({ error: 'Accès refusé' }, { status: 403 }) } as const;
  }
  return { auth, accessUser, db, attachment, snapshot } as const;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> | { id: string } }) {
  const ctx = await load(request, params);
  if ('error' in ctx) return ctx.error;
  return new NextResponse(new Uint8Array(ctx.attachment.content), {
    headers: attachmentDownloadHeaders({
      mimeType: ctx.attachment.mimeType,
      fileName: ctx.attachment.fileName,
      sizeBytes: ctx.attachment.sizeBytes,
    }),
  });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> | { id: string } }) {
  const ctx = await load(request, params);
  if ('error' in ctx) return ctx.error;
  const disabled = await planningFeatureGuard(ctx.db, 'collaboration');
  if (disabled) return disabled;
  if (!canManagePlanningEventWorkspace(ctx.accessUser) && ctx.attachment.uploadedByUserId !== ctx.auth.user.id) {
    return NextResponse.json({ error: 'Suppression non autorisée' }, { status: 403 });
  }
  await deletePlanningAttachment(ctx.db, ctx.attachment.id);
  await logAuditEntry(ctx.db, {
    user: ctx.auth.user,
    entityType: 'PlanningCollaboration',
    entityId: ctx.attachment.id,
    action: 'delete',
    before: { fileName: ctx.attachment.fileName, eventType: ctx.attachment.eventType, eventId: ctx.attachment.eventId },
    after: null,
  });
  return NextResponse.json({ success: true });
}
