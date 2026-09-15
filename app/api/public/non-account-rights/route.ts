import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import {
  checkCapabilityIpRateLimit,
  recordCapabilityIpAttempt,
} from '@/lib/auth/capability-rate-limit';
import { createRightsRequest, parseRightsType } from '@/lib/non-account-contacts/rights';
import { contactLifecycleResponse } from '@/lib/non-account-contacts/referentiel-write';
import { PUBLIC_RIGHTS_RECEIVED } from '@/lib/non-account-contacts/constants';
import { normalizeTelephone } from '@/lib/non-account-contacts/meta';

const GENERIC = { received: true, message: PUBLIC_RIGHTS_RECEIVED };

export async function POST(request: NextRequest) {
  const db = await getDb();
  const limited = await checkCapabilityIpRateLimit(db, request, 'non-account-rights');
  if (limited) return limited;

  try {
    const body = await request.json() as {
      clubId?: unknown;
      type?: unknown;
      email?: unknown;
      telephone?: unknown;
    };
    const clubId = typeof body.clubId === 'string' ? body.clubId.trim() : '';
    if (!clubId || clubId.length > 64) {
      return NextResponse.json({ error: 'Identifiant de club requis' }, { status: 400 });
    }

    await recordCapabilityIpAttempt(db, request, 'non-account-rights');

    const type = parseRightsType(body.type);
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const telephone = normalizeTelephone(body.telephone);

    if (await isClubTenantActive(db, clubId)) {
      await createRightsRequest(db, { clubId, type, email, telephone });
    }

    return NextResponse.json(GENERIC, { status: 202 });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    console.error('Error recording public non-account rights request:', error);
    return NextResponse.json({ error: 'Demande impossible pour le moment.' }, { status: 500 });
  }
}
