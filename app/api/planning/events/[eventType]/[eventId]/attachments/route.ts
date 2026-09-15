import { logError } from '@/lib/observability/log';
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
import { listPlanningAttachments, savePlanningAttachment } from '@/lib/planning/records';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function validEventType(value: string): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

function safeFileName(value: string): string {
  return value.replace(/[\\/\0\r\n]/g, '_').replace(/[^\p{L}\p{N}._() -]/gu, '_').slice(0, 180) || 'document';
}

async function loadContext(request: NextRequest, params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string }) {
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
  return { auth, accessUser, db, snapshot, eventType: resolved.eventType, eventId: resolved.eventId } as const;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await loadContext(request, params);
  if ('error' in ctx) return ctx.error;
  return NextResponse.json({ attachments: await listPlanningAttachments(ctx.db, ctx.eventType, ctx.eventId), canManage: canManagePlanningEventWorkspace(ctx.accessUser) });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string; eventId: string }> | { eventType: string; eventId: string } },
) {
  const ctx = await loadContext(request, params);
  if ('error' in ctx) return ctx.error;
  if (!canManagePlanningEventWorkspace(ctx.accessUser)) {
    return NextResponse.json({ error: 'Ajout de document réservé aux administrateurs' }, { status: 403 });
  }

  try {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'Fichier requis' }, { status: 400 });
    if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: 'Le fichier doit faire au maximum 5 MiB' }, { status: 413 });
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json({ error: 'Type de fichier non autorisé' }, { status: 415 });
    }
    const content = Buffer.from(await file.arrayBuffer());
    const attachment = await savePlanningAttachment(ctx.db, {
      eventType: ctx.eventType,
      eventId: ctx.eventId,
      fileName: safeFileName(file.name),
      mimeType: file.type,
      sizeBytes: file.size,
      content,
      uploadedByUserId: ctx.auth.user.id,
    });
    await logAuditEntry(ctx.db, {
      user: ctx.auth.user,
      entityType: 'PlanningCollaboration',
      entityId: attachment.id,
      action: 'create',
      before: null,
      after: { eventType: ctx.eventType, eventId: ctx.eventId, fileName: attachment.fileName, mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes },
    });
    return NextResponse.json({ success: true, attachment });
  } catch (error) {
    logError('app.unhandled', 'Attachment upload failed:', error);
    return NextResponse.json({ error: 'Impossible d’ajouter le document' }, { status: 500 });
  }
}
