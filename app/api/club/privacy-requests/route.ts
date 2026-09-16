import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/privacy/catalog';
import { listPrivacyRequestsForClub, toPrivacyRequestDto } from '@/lib/privacy/requests';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const db = await getDb();
  const rows = await listPrivacyRequestsForClub(db, auth.user.clubId);
  return NextResponse.json({
    legalNotice: PRIVACY_NO_LEGAL_PROMISE,
    requests: rows.map(toPrivacyRequestDto),
  });
}
