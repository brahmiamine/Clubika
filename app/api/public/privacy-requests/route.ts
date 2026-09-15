import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import { PRIVACY_NO_LEGAL_PROMISE, isPrivacyRequestType } from '@/lib/privacy/catalog';
import { createPrivacyRequest, notifyAdminsOfPrivacyRequest } from '@/lib/privacy/requests';
import { checkCapabilityIpRateLimit, recordCapabilityIpAttempt } from '@/lib/auth/capability-rate-limit';
import { setCurrentClubId } from '@/lib/auth/club-context';

export async function POST(request: NextRequest) {
  try {
    const db = await getDb();
    const blocked = await checkCapabilityIpRateLimit(db, request, 'privacy-public-intake');
    if (blocked) return blocked;
    await recordCapabilityIpAttempt(db, request, 'privacy-public-intake');

    const body = await request.json();
    const clubId = typeof body.clubId === 'string' ? body.clubId.trim() : '';
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (!clubId || !email) {
      return NextResponse.json({ error: 'Club et e-mail requis' }, { status: 400 });
    }
    if (!isPrivacyRequestType(body.type)) {
      return NextResponse.json({ error: 'Type de demande invalide' }, { status: 400 });
    }
    if (!(await isClubTenantActive(db, clubId))) {
      return NextResponse.json({
        success: true,
        legalNotice: PRIVACY_NO_LEGAL_PROMISE,
        message: 'Si ce club existe, la demande a été enregistrée.',
      });
    }
    setCurrentClubId(clubId);
    const row = await createPrivacyRequest(db, {
      clubId,
      type: body.type,
      subjectEmail: email,
      identityVerified: false,
    });
    await notifyAdminsOfPrivacyRequest(db, body.type, row.id);
    return NextResponse.json({
      success: true,
      legalNotice: PRIVACY_NO_LEGAL_PROMISE,
      receiptId: row.id,
      request: { id: row.id, type: row.type, status: row.status, createdAt: row.createdAt },
    });
  } catch (error) {
    console.error('Public privacy intake failed:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer la demande' }, { status: 500 });
  }
}
