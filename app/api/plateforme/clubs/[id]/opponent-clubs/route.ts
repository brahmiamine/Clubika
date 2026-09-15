import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ClubTenantEntity } from '@/lib/db/schemas';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { rejectIfClubNotWritable } from '@/lib/tenant-offboarding/writable';

export interface OpponentClub {
  nom: string;
  logo: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

async function resolveClubId(
  params: Promise<{ id: string }> | { id: string },
): Promise<string> {
  const resolved = params instanceof Promise ? await params : params;
  return resolved.id;
}

async function assertClubExists(clubId: string): Promise<NextResponse | null> {
  const db = await getDb();
  const club = await db.getRepository<ClubTenantEntity>('ClubTenant').findOneBy({ id: clubId });
  if (!club) {
    return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const clubId = await resolveClubId(params);
    const notFound = await assertClubExists(clubId);
    if (notFound) return notFound;

    const db = await getDb();
    const rows = await db.getRepository('Club').find({ where: { clubId }, order: { nom: 'ASC' } });
    const clubs: OpponentClub[] = rows.map((club) => ({ nom: String(club.nom), logo: String(club.logo) }));

    return NextResponse.json({ clubs });
  } catch (error) {
    logError('app.unhandled', 'Error reading opponent clubs from DB:', error);
    return NextResponse.json({ error: 'Impossible de charger les clubs' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const clubId = await resolveClubId(params);
    const blocked = await rejectIfClubNotWritable(await getDb(), clubId);
    if (blocked) return blocked;

    const body = await request.json();
    const { nom, logo } = body;

    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom du club est requis' }, { status: 400 });
    }
    if (!logo || typeof logo !== 'string' || logo.trim() === '') {
      return NextResponse.json({ error: 'Le logo du club est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository('Club');

    const existing = await repo
      .createQueryBuilder('club')
      .where('LOWER(club.nom) = :normalizedNom AND club.clubId = :clubId', { normalizedNom: normalize(nom), clubId })
      .getOne();
    if (existing) {
      return NextResponse.json({ error: 'Un club avec ce nom existe déjà' }, { status: 400 });
    }

    await repo.save({ clubId, nom: nom.trim(), logo: logo.trim() });

    const clubs = (await repo.find({ where: { clubId }, order: { nom: 'ASC' } })).map((item) => ({
      nom: String(item.nom),
      logo: String(item.logo),
    }));

    return NextResponse.json({ success: true, clubs });
  } catch (error) {
    logError('app.unhandled', 'Error adding opponent club in DB:', error);
    return NextResponse.json({ error: 'Impossible de créer le club' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const clubId = await resolveClubId(params);
    const blocked = await rejectIfClubNotWritable(await getDb(), clubId);
    if (blocked) return blocked;

    const body = await request.json();
    const { oldNom, nom, logo } = body;

    if (!oldNom || typeof oldNom !== 'string' || oldNom.trim() === '') {
      return NextResponse.json({ error: 'L\'ancien nom du club est requis' }, { status: 400 });
    }
    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom du club est requis' }, { status: 400 });
    }
    if (!logo || typeof logo !== 'string' || logo.trim() === '') {
      return NextResponse.json({ error: 'Le logo du club est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository('Club');

    const club = await repo
      .createQueryBuilder('club')
      .where('LOWER(club.nom) = :normalizedOldNom AND club.clubId = :clubId', { normalizedOldNom: normalize(oldNom), clubId })
      .getOne();
    if (!club) {
      return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
    }

    const existing = await repo
      .createQueryBuilder('club')
      .where('LOWER(club.nom) = :normalizedNom AND club.clubId = :clubId', { normalizedNom: normalize(nom), clubId })
      .getOne();
    if (existing && existing.id !== club.id) {
      return NextResponse.json({ error: 'Un club avec ce nom existe déjà' }, { status: 400 });
    }

    club.nom = nom.trim();
    club.logo = logo.trim();
    await repo.save(club);

    const clubs = (await repo.find({ where: { clubId }, order: { nom: 'ASC' } })).map((item) => ({
      nom: String(item.nom),
      logo: String(item.logo),
    }));

    return NextResponse.json({ success: true, clubs });
  } catch (error) {
    logError('app.unhandled', 'Error updating opponent club in DB:', error);
    return NextResponse.json({ error: 'Impossible de modifier le club' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const clubId = await resolveClubId(params);
    const blocked = await rejectIfClubNotWritable(await getDb(), clubId);
    if (blocked) return blocked;

    const { searchParams } = new URL(request.url);
    const nom = searchParams.get('nom');
    if (!nom || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom du club est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository('Club');
    const club = await repo
      .createQueryBuilder('club')
      .where('LOWER(club.nom) = :normalizedNom AND club.clubId = :clubId', { normalizedNom: normalize(nom), clubId })
      .getOne();
    if (!club) {
      return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
    }

    await repo.remove(club);

    const clubs = (await repo.find({ where: { clubId }, order: { nom: 'ASC' } })).map((item) => ({
      nom: String(item.nom),
      logo: String(item.logo),
    }));

    return NextResponse.json({ success: true, clubs });
  } catch (error) {
    logError('app.unhandled', 'Error deleting opponent club in DB:', error);
    return NextResponse.json({ error: 'Impossible de supprimer le club' }, { status: 500 });
  }
}
