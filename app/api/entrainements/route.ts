import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import type { EntrainementsData } from '@/types/match';
import { groupMatchesByDate } from '@/lib/db/helpers';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { parseEntrainementPayload } from '@/lib/db/planning-payload-codecs';
import { POST as canonicalPost } from '@/app/api/planning/events/[eventType]/route';
import {
  DELETE as canonicalDelete,
  PUT as canonicalPut,
} from '@/app/api/planning/events/[eventType]/[eventId]/route';

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const rows = await db.getRepository('Entrainement').findBy({ clubId: auth.user.clubId });
    const entrainements = rows
      .map((row) => parseEntrainementPayload(row.payload, row.id))
      .filter((item) => Boolean(item?.id));
    const data: EntrainementsData = { entrainements: groupMatchesByDate(entrainements) };
    return NextResponse.json(data);
  } catch (error) {
    logError('app.unhandled', 'Error reading entrainements from DB:', error);
    return NextResponse.json({ error: 'Failed to load entrainements' }, { status: 500 });
  }
}

/**
 * Compatibilité temporaire : la lecture historique reste ici, mais toutes les écritures
 * délèguent au contrat canonique `/api/planning/events/...` (issue #275).
 */
export async function POST(request: NextRequest) {
  return canonicalPost(request, { params: { eventType: 'entrainement' } });
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Requête invalide' }, { status: 400 });
  }
  const rawId = (body as Record<string, unknown>).id;
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });

  const forwarded = new NextRequest(
    new URL(`/api/planning/events/entrainement/${encodeURIComponent(id)}`, request.url),
    {
      method: 'PUT',
      headers: request.headers,
      body: JSON.stringify(body),
    },
  );
  return canonicalPut(forwarded, { params: { eventType: 'entrainement', eventId: id } });
}

export async function DELETE(request: NextRequest) {
  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id) return NextResponse.json({ error: 'ID is required' }, { status: 400 });
  return canonicalDelete(request, { params: { eventType: 'entrainement', eventId: id } });
}
