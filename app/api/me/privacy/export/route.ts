import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/privacy/catalog';
import { createPrivacyRequest } from '@/lib/privacy/requests';
import { issueExportToken } from '@/lib/privacy/download';

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  try {
    const db = await getDb();
    const user = await db.getRepository<UserEntity>('User').findOneBy({ id: auth.user.id, clubId: auth.user.clubId });
    if (!user) return NextResponse.json({ error: 'Utilisateur introuvable' }, { status: 404 });

    const row = await createPrivacyRequest(db, {
      clubId: auth.user.clubId,
      type: 'portability',
      subjectUserId: user.id,
      subjectEmail: user.email,
      identityVerified: true,
    });
    const issued = await issueExportToken(db, user, row.id);
    row.status = 'completed';
    row.decisionCode = 'granted';
    row.responseProof = 'export-token';
    row.completedAt = new Date();
    await db.getRepository('PrivacyRequest').save(row);

    return NextResponse.json({
      success: true,
      legalNotice: PRIVACY_NO_LEGAL_PROMISE,
      expiresAt: issued.expiresAt,
      downloadPath: issued.downloadPath,
      token: issued.token,
      formats: ['json', 'html'],
    });
  } catch (error) {
    console.error('Privacy export issue failed:', error);
    return NextResponse.json({ error: 'Impossible de préparer l’export' }, { status: 500 });
  }
}
