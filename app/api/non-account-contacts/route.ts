import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { hasAccountAccess } from '@/lib/auth/placeholder-account';
import { loadContactMeta, loadNoticeConfig, serializeMeta, upsertNoticeConfig } from '@/lib/non-account-contacts/meta';
import { maskTelephone } from '@/lib/non-account-contacts/format';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/non-account-contacts/constants';
import { contactLifecycleResponse } from '@/lib/non-account-contacts/referentiel-write';
import { logError } from '@/lib/observability/log';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const users = await db.getRepository<UserEntity>('User').find({
      where: { clubId: auth.user.clubId },
      order: { nom: 'ASC' },
    });
    const fiches = [];
    for (const user of users) {
      if (hasAccountAccess(user)) continue;
      const meta = await loadContactMeta(db, user.id);
      fiches.push({
        id: user.id,
        nom: user.nom,
        telephone: maskTelephone(user.telephone),
        telephoneMasked: Boolean(user.telephone),
        planningFunctions: user.planningFunctions,
        meta: serializeMeta(meta),
      });
    }
    const notice = await loadNoticeConfig(db, auth.user.clubId);
    return NextResponse.json({
      fiches,
      notice: {
        version: notice?.noticeVersion ?? '',
        text: notice?.noticeText ?? '',
        disclaimer: PRIVACY_NO_LEGAL_PROMISE,
      },
    });
  } catch (error) {
    logError('app.unhandled', 'Error listing non-account contacts:', error);
    return NextResponse.json({ error: 'Impossible de charger les fiches sans compte' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json() as { noticeVersion?: string; noticeText?: string };
    const db = await getDb();
    const notice = await upsertNoticeConfig(db, auth.user.clubId, body);
    return NextResponse.json({
      success: true,
      notice: {
        version: notice.noticeVersion,
        text: notice.noticeText,
        disclaimer: PRIVACY_NO_LEGAL_PROMISE,
      },
    });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    logError('app.unhandled', 'Error updating notice config:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer la notice' }, { status: 500 });
  }
}
