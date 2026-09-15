import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { assertRoomAccess, ChatAccessError, ChatValidationError } from '@/lib/chat/service';
import {
  assertAttachmentWithinLimits,
  attachmentKindForMime,
  ChatAttachmentRateLimitError,
  ChatAttachmentValidationError,
  documentContentMatchesMime,
  documentKindFromExtension,
  normalizeMimeType,
  saveChatAttachmentWithinQuota,
} from '@/lib/chat/attachments';
import { setCurrentClubId } from '@/lib/auth/club-context';

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
    const declaredMimeType = normalizeMimeType(file.type);
    let kind = attachmentKindForMime(declaredMimeType);
    let mimeType = declaredMimeType;

    if (kind === 'document') {
      // La MIME annoncée par le client est falsifiable et un document (contrairement à
      // une image/vidéo/audio) est susceptible d'être rouvert manuellement par un autre
      // membre : son contenu doit confirmer le format annoncé (issue #265, revue Codex).
      if (!documentContentMatchesMime(mimeType, content)) {
        return NextResponse.json({ error: 'Le contenu du fichier ne correspond pas au type de document annoncé' }, { status: 415 });
      }
    } else if (!kind) {
      // MIME non reconnue : certains navigateurs/OS annoncent une MIME générique pour
      // .csv/.xls/.xlsx/.pdf (ex. text/plain, application/octet-stream). On se rabat sur
      // l'extension, mais seulement si le contenu confirme réellement ce format.
      const fallback = documentKindFromExtension(file.name || '', content);
      if (fallback) {
        kind = 'document';
        mimeType = fallback.mimeType;
      }
    }
    if (!kind) {
      return NextResponse.json({ error: 'Type de fichier non supporté (image, gif, vidéo, audio, PDF, Excel ou CSV uniquement)' }, { status: 415 });
    }
    assertAttachmentWithinLimits(kind, file.size);

    const meta = await saveChatAttachmentWithinQuota(db, {
      clubId: auth.user.clubId,
      roomId,
      kind,
      fileName: file.name || kind,
      mimeType,
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
    if (error instanceof ChatAttachmentValidationError) return NextResponse.json({ error: error.message }, { status: 413 });
    if (error instanceof ChatAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ChatValidationError) return NextResponse.json({ error: error.message }, { status: 400 });
    logError('app.unhandled', 'Chat upload failed:', error);
    return NextResponse.json({ error: 'Envoi du fichier impossible' }, { status: 500 });
  }
}
