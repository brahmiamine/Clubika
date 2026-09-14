import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';

export interface Stade {
  nom: string;
  adresse: string | null;
  googleMapsUrl: string;
}

export interface StadesData {
  stades: Stade[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const repo = db.getRepository('Stade');
    const rows = await repo.find({ where: { clubId: auth.user.clubId }, order: { nom: 'ASC' } });
    const data: StadesData = {
      stades: rows.map((stade) => ({
        nom: String(stade.nom),
        adresse: stade.adresse ? String(stade.adresse) : null,
        googleMapsUrl: String(stade.googleMapsUrl),
      })),
    };

    return NextResponse.json(data);
  } catch (error) {
    logError('app.unhandled', 'Error reading stades from DB:', error);
    return NextResponse.json(
      { error: 'Failed to load stades' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const { oldNom, nom, adresse, googleMapsUrl } = body;

    if (!oldNom || typeof oldNom !== 'string' || oldNom.trim() === '') {
      return NextResponse.json(
        { error: 'L\'ancien nom du stade est requis' },
        { status: 400 }
      );
    }

    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json(
        { error: 'Le nom du stade est requis' },
        { status: 400 }
      );
    }

    if (!googleMapsUrl || typeof googleMapsUrl !== 'string' || googleMapsUrl.trim() === '') {
      return NextResponse.json(
        { error: 'L\'URL Google Maps est requise' },
        { status: 400 }
      );
    }

    const db = await getDb();
    const repo = db.getRepository('Stade');
    const clubId = auth.user.clubId;

    const stade = await repo
      .createQueryBuilder('stade')
      .where('LOWER(stade.nom) = :normalizedOldNom AND stade.clubId = :clubId', { normalizedOldNom: normalize(oldNom), clubId })
      .getOne();

    if (!stade) {
      return NextResponse.json(
        { error: 'Stade non trouvé' },
        { status: 404 }
      );
    }

    const existing = await repo
      .createQueryBuilder('stade')
      .where('LOWER(stade.nom) = :normalizedNom AND stade.clubId = :clubId', { normalizedNom: normalize(nom), clubId })
      .getOne();

    if (existing && existing.id !== stade.id) {
      return NextResponse.json(
        { error: 'Un stade avec ce nom existe déjà' },
        { status: 400 }
      );
    }

    stade.nom = nom.trim();
    stade.adresse = adresse && typeof adresse === 'string' ? adresse.trim() || null : null;
    stade.googleMapsUrl = googleMapsUrl.trim();

    await repo.save(stade);

    const data: StadesData = {
      stades: (await repo.find({ where: { clubId }, order: { nom: 'ASC' } })).map((item) => ({
        nom: String(item.nom),
        adresse: item.adresse ? String(item.adresse) : null,
        googleMapsUrl: String(item.googleMapsUrl),
      })),
    };

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logError('app.unhandled', 'Error updating stades in DB:', error);
    return NextResponse.json(
      { error: 'Failed to update stade' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const { searchParams } = new URL(request.url);
    const nom = searchParams.get('nom');

    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json(
        { error: 'Le nom du stade est requis' },
        { status: 400 }
      );
    }

    const db = await getDb();
    const repo = db.getRepository('Stade');
    const clubId = auth.user.clubId;

    const stade = await repo
      .createQueryBuilder('stade')
      .where('LOWER(stade.nom) = :normalizedNom AND stade.clubId = :clubId', { normalizedNom: normalize(nom), clubId })
      .getOne();

    if (!stade) {
      return NextResponse.json(
        { error: 'Stade non trouvé' },
        { status: 404 }
      );
    }

    await repo.remove(stade);

    const data: StadesData = {
      stades: (await repo.find({ where: { clubId }, order: { nom: 'ASC' } })).map((item) => ({
        nom: String(item.nom),
        adresse: item.adresse ? String(item.adresse) : null,
        googleMapsUrl: String(item.googleMapsUrl),
      })),
    };

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logError('app.unhandled', 'Error deleting stade in DB:', error);
    return NextResponse.json(
      { error: 'Failed to delete stade' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const { nom, adresse, googleMapsUrl } = body;

    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json(
        { error: 'Le nom du stade est requis' },
        { status: 400 }
      );
    }

    if (!googleMapsUrl || typeof googleMapsUrl !== 'string' || googleMapsUrl.trim() === '') {
      return NextResponse.json(
        { error: 'L\'URL Google Maps est requise' },
        { status: 400 }
      );
    }

    const db = await getDb();
    const repo = db.getRepository('Stade');
    const clubId = auth.user.clubId;

    const existing = await repo
      .createQueryBuilder('stade')
      .where('LOWER(stade.nom) = :normalizedNom AND stade.clubId = :clubId', { normalizedNom: normalize(nom), clubId })
      .getOne();

    if (existing) {
      return NextResponse.json(
        { error: 'Un stade avec ce nom existe déjà' },
        { status: 400 }
      );
    }

    await repo.save({
      clubId,
      nom: nom.trim(),
      adresse: adresse && typeof adresse === 'string' ? adresse.trim() || null : null,
      googleMapsUrl: googleMapsUrl.trim(),
    });

    const data: StadesData = {
      stades: (await repo.find({ where: { clubId }, order: { nom: 'ASC' } })).map((item) => ({
        nom: String(item.nom),
        adresse: item.adresse ? String(item.adresse) : null,
        googleMapsUrl: String(item.googleMapsUrl),
      })),
    };

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logError('app.unhandled', 'Error adding stade in DB:', error);
    return NextResponse.json(
      { error: 'Failed to add stade' },
      { status: 500 }
    );
  }
}
