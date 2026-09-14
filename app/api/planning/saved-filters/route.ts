import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import {
  deletePlanningRecord,
  getPlanningRecord,
  listPlanningRecords,
  planningRecordId,
  savePlanningRecord,
} from '@/lib/planning/records';
import { setCurrentClubId } from '@/lib/auth/club-context';

type EventTypeFilter = 'all' | 'officiel' | 'amical' | 'entrainement' | 'plateau';
type VenueFilter = 'all' | 'domicile' | 'extérieur';

interface SavedMatchFilters {
  clubSearch: string;
  arbitreAFPSearch: string;
  venue: VenueFilter;
  eventType: EventTypeFilter;
}

interface SavedFilterPayload {
  name: string;
  filters: SavedMatchFilters;
}

const EVENT_TYPES: EventTypeFilter[] = ['all', 'officiel', 'amical', 'entrainement', 'plateau'];
const VENUES: VenueFilter[] = ['all', 'domicile', 'extérieur'];

function sanitizeFilters(value: unknown): SavedMatchFilters | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const eventType = EVENT_TYPES.includes(raw.eventType as EventTypeFilter) ? raw.eventType as EventTypeFilter : 'all';
  const venue = VENUES.includes(raw.venue as VenueFilter) ? raw.venue as VenueFilter : 'all';
  return {
    clubSearch: typeof raw.clubSearch === 'string' ? raw.clubSearch.trim().slice(0, 200) : '',
    arbitreAFPSearch: typeof raw.arbitreAFPSearch === 'string' ? raw.arbitreAFPSearch.trim().slice(0, 200) : '',
    venue,
    eventType,
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const db = await getDb();
  const records = await listPlanningRecords<SavedFilterPayload>(db, {
    kind: 'saved-filter',
    ownerUserId: auth.user.id,
  }, 100);
  return NextResponse.json({
    filters: records.map((record) => ({
      id: record.id,
      name: record.payload.name,
      filters: record.payload.filters,
      createdAt: record.createdAt,
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : '';
    const filters = sanitizeFilters(body.filters);
    if (!name || !filters) {
      return NextResponse.json({ error: 'Nom et filtres requis' }, { status: 400 });
    }

    const id = planningRecordId('saved-filter');
    const db = await getDb();
    await savePlanningRecord<SavedFilterPayload>(db, {
      id,
      kind: 'saved-filter',
      ownerUserId: auth.user.id,
      payload: { name, filters },
    });

    return NextResponse.json({ success: true, filter: { id, name, filters } });
  } catch (error) {
    logError('app.unhandled', 'Saving planning filter failed:', error);
    return NextResponse.json({ error: 'Impossible d’enregistrer ce filtre' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id?.startsWith('saved-filter:')) {
    return NextResponse.json({ error: 'Filtre invalide' }, { status: 400 });
  }

  const db = await getDb();
  const record = await getPlanningRecord<SavedFilterPayload>(db, id);
  if (!record || record.ownerUserId !== auth.user.id) {
    return NextResponse.json({ error: 'Filtre introuvable' }, { status: 404 });
  }
  await deletePlanningRecord(db, id);
  return NextResponse.json({ success: true });
}
