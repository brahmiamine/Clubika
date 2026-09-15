import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { importContactCsv } from '@/lib/non-account-contacts/csv';
import { contactLifecycleResponse } from '@/lib/non-account-contacts/referentiel-write';

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const contentType = request.headers.get('content-type') ?? '';
    let csv = '';
    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      csv = await request.text();
    } else {
      const body = await request.json() as { csv?: unknown };
      if (typeof body.csv !== 'string') {
        return NextResponse.json({ error: 'Fichier CSV manquant.' }, { status: 400 });
      }
      csv = body.csv;
    }

    const db = await getDb();
    const result = await importContactCsv(db, auth.user.clubId, auth.user.id, csv);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    console.error('Error importing non-account contacts:', error);
    return NextResponse.json({ error: 'Import impossible' }, { status: 500 });
  }
}
