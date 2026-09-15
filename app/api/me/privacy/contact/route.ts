import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/privacy/catalog';
import { createPrivacyRequest } from '@/lib/privacy/requests';
import { requestEmailChange, updateSubjectPhone } from '@/lib/privacy/rectify';

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  try {
    const body = await request.json();
    const db = await getDb();
    const user = await db.getRepository<UserEntity>('User').findOneBy({ id: auth.user.id, clubId: auth.user.clubId });
    if (!user) return NextResponse.json({ error: 'Utilisateur introuvable' }, { status: 404 });

    if ('telephone' in body) {
      const telephone = typeof body.telephone === 'string' ? body.telephone : null;
      try {
        await updateSubjectPhone(db, user, telephone);
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Téléphone invalide' }, { status: 400 });
      }
      await createPrivacyRequest(db, {
        clubId: auth.user.clubId,
        type: 'rectification',
        subjectUserId: auth.user.id,
        subjectEmail: auth.user.email,
        identityVerified: true,
      }).then(async (row) => {
        row.status = 'completed';
        row.decisionCode = 'granted';
        row.responseProof = 'phone-updated';
        row.completedAt = new Date();
        await db.getRepository('PrivacyRequest').save(row);
      });
      return NextResponse.json({ success: true, legalNotice: PRIVACY_NO_LEGAL_PROMISE });
    }

    if (typeof body.email === 'string') {
      try {
        const pending = await requestEmailChange(db, user, body.email);
        return NextResponse.json({
          success: true,
          verificationRequired: true,
          legalNotice: PRIVACY_NO_LEGAL_PROMISE,
          ...(process.env.NODE_ENV !== 'production'
            ? { confirmToken: pending.confirmToken, expiresAt: pending.expiresAt }
            : { expiresAt: pending.expiresAt }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Rectification impossible';
        const conflict = message.includes('déjà utilisé');
        return NextResponse.json({ error: message }, { status: conflict ? 409 : 400 });
      }
    }

    return NextResponse.json({ error: 'Aucun champ à rectifier' }, { status: 400 });
  } catch (error) {
    console.error('Privacy contact update failed:', error);
    return NextResponse.json({ error: 'Impossible de rectifier le contact' }, { status: 500 });
  }
}
