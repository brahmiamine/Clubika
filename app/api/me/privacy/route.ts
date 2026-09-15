import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { PRIVACY_NO_LEGAL_PROMISE, isPrivacyRequestType } from '@/lib/privacy/catalog';
import { logError } from '@/lib/observability/log';
import {
  createPrivacyRequest,
  listPrivacyRequestsForUser,
  notifyAdminsOfPrivacyRequest,
  toPrivacyRequestDto,
} from '@/lib/privacy/requests';

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const db = await getDb();
  const user = await db.getRepository<UserEntity>('User').findOneBy({ id: auth.user.id, clubId: auth.user.clubId });
  if (!user) return NextResponse.json({ error: 'Utilisateur introuvable' }, { status: 404 });
  const requests = await listPrivacyRequestsForUser(db, auth.user.clubId, auth.user.id);
  return NextResponse.json({
    legalNotice: PRIVACY_NO_LEGAL_PROMISE,
    telephone: user.telephone,
    email: user.email,
    processingRestrictedAt: user.processingRestrictedAt ?? null,
    processingOpposedAt: user.processingOpposedAt ?? null,
    requests: requests.map(toPrivacyRequestDto),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  try {
    const body = await request.json();
    if (!isPrivacyRequestType(body.type) || body.type === 'rectification') {
      return NextResponse.json({ error: 'Type de demande invalide' }, { status: 400 });
    }
    const db = await getDb();
    const row = await createPrivacyRequest(db, {
      clubId: auth.user.clubId,
      type: body.type,
      subjectUserId: auth.user.id,
      subjectEmail: auth.user.email,
      identityVerified: true,
    });
    await notifyAdminsOfPrivacyRequest(db, body.type, row.id);
    return NextResponse.json({
      success: true,
      legalNotice: PRIVACY_NO_LEGAL_PROMISE,
      request: toPrivacyRequestDto(row),
    });
  } catch (error) {
    logError('app.unhandled', 'Privacy request create failed:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer la demande' }, { status: 500 });
  }
}
