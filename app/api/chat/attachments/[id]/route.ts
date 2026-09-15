import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { assertRoomAccess, ChatAccessError, ChatValidationError } from '@/lib/chat/service';
import { getChatAttachment } from '@/lib/chat/attachments';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { attachmentDownloadHeaders } from '@/lib/security/attachment-headers';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const { id } = context.params instanceof Promise ? await context.params : context.params;
    const db = await getDb();
    const attachment = await getChatAttachment(db, id);
    if (!attachment || attachment.clubId !== auth.user.clubId) {
      return NextResponse.json({ error: 'Fichier introuvable' }, { status: 404 });
    }
    await assertRoomAccess(db, auth.user, attachment.roomId);

    return new NextResponse(new Uint8Array(attachment.content), {
      headers: attachmentDownloadHeaders({
        mimeType: attachment.mimeType,
        fileName: attachment.fileName,
        sizeBytes: attachment.sizeBytes,
      }),
    });
  } catch (error) {
    if (error instanceof ChatAccessError) return NextResponse.json({ error: error.message }, { status: 403 });
    if (error instanceof ChatValidationError) return NextResponse.json({ error: error.message }, { status: 404 });
    logError('app.unhandled', 'Chat attachment fetch failed:', error);
    return NextResponse.json({ error: 'Impossible de charger le fichier' }, { status: 500 });
  }
}
