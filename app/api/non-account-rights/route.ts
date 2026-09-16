import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { NonAccountRightsRequestEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { applyRightsAction, serializeRightsRequest } from '@/lib/non-account-contacts/rights';
import { contactLifecycleResponse } from '@/lib/non-account-contacts/referentiel-write';
import { ContactLifecycleError } from '@/lib/non-account-contacts/constants';
import { logError } from '@/lib/observability/log';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const rows = await db.getRepository<NonAccountRightsRequestEntity>('NonAccountRightsRequest').find({
      where: { clubId: auth.user.clubId },
      order: { createdAt: 'DESC' },
    });
    return NextResponse.json({ requests: rows.map(serializeRightsRequest) });
  } catch (error) {
    logError('app.unhandled', 'Error listing non-account rights requests:', error);
    return NextResponse.json({ error: 'Impossible de charger les demandes' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json() as { id?: unknown; action?: unknown; status?: unknown };
    if (typeof body.id !== 'string' || !body.id) {
      return NextResponse.json({ error: 'Identifiant de demande requis' }, { status: 400 });
    }
    const db = await getDb();
    const row = await db.getRepository<NonAccountRightsRequestEntity>('NonAccountRightsRequest').findOneBy({
      id: body.id,
      clubId: auth.user.clubId,
    });
    if (!row) {
      return NextResponse.json({ error: 'Demande introuvable' }, { status: 404 });
    }

    if (body.status === 'rejected') {
      row.status = 'rejected';
      row.processedAt = new Date();
      await db.getRepository<NonAccountRightsRequestEntity>('NonAccountRightsRequest').save(row);
      return NextResponse.json({ success: true, request: serializeRightsRequest(row) });
    }

    const action = body.action;
    if (action !== 'opposition' && action !== 'erasure' && action !== 'acknowledge') {
      throw new ContactLifecycleError('Action inconnue. Choisissez opposition, erasure ou acknowledge.', 400);
    }
    await applyRightsAction(db, row, action);
    return NextResponse.json({ success: true, request: serializeRightsRequest(row) });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    logError('app.unhandled', 'Error processing non-account rights request:', error);
    return NextResponse.json({ error: 'Traitement impossible' }, { status: 500 });
  }
}
