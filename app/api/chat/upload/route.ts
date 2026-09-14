import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { assertRoomAccess, ChatAccessError, ChatValidationError } from '@/lib/chat/service';
import {
  assertAttachmentWithinLimits,
  ChatAttachmentRateLimitError,
  ChatAttachmentValidationError,
  saveChatAttachmentWithinQuota,
} from '@/lib/chat/attachments';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { AttachmentRejectedError, inspectAttachment } from '@/lib/security/file-inspect';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const formData = await request.formData();
    const roomId = formData.get('roomId');
    const file = formData.get('file');
    if (typeof roomId !== 'string' || !roomId) {
      return NextResponse.json({ error: 'Salon invalide' }, { status: 400 });
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Fichier manquant' }, { status: 400 });
    }

    const db = await getDb();
    await assertRoomAccess(db, auth.user, roomId);

    const content = Buffer.from(await file.arrayBuffer());
    const inspected = inspectAttachment({
      usage: 'chat',
      fileName: file.name || 'fichier',
      declaredMime: file.type,
      content,
    });
    assertAttachmentWithinLimits(inspected.kind, file.size);

    const meta = await saveChatAttachmentWithinQuota(db, {
      clubId: auth.user.clubId,
      roomId,
      kind: inspected.kind,
      fileName: inspected.safeName,
      mimeType: inspected.canonicalMime,
      content,
      uploadedByUserId: auth.user.id,
    });

    return NextResponse.json({
      attachment: {
        type: meta.kind,
        url: `/api/chat/attachments/${meta.id}`,
        mimeType: meta.mimeType,
        name: meta.fileName,
        size: meta.sizeBytes,
      },
    });
  } catch (error) {
    if (error instanceof ChatAttachmentRateLimitError) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    if (error instanceof AttachmentRejectedError) {
      return NextResponse.json({ error: 'Type de fichier non autorisé' }, { status: 415 });
    }
    if (error instanceof ChatAttachmentValidationError) return NextResponse.json({ error: error.message }, { status: 413 });
    if (error instanceof ChatAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ChatValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    console.error('Chat upload failed:', error);
    return NextResponse.json({ error: 'Envoi du fichier impossible' }, { status: 500 });
  }
}
