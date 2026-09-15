import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { normalizeIndisponibilites, type OfficielIndisponibilite } from '@/lib/utils/officiel-availability';
import { requireRole } from '@/lib/auth/require';
import { normalizePlanningFunctions, WRITE_ROLES, type PlanningFunction } from '@/lib/auth/roles';
import { hashPassword } from '@/lib/auth/password';
import { generatePlaceholderEmail } from '@/lib/auth/placeholder-account';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { applyTelephoneGateAndMeta, contactLifecycleResponse } from '@/lib/non-account-contacts/referentiel-write';
import { normalizeTelephone } from '@/lib/non-account-contacts/meta';
import { assertTelephoneAllowed, parseProvenance, parsePurpose, upsertContactMeta } from '@/lib/non-account-contacts/meta';

/** Fonction opérationnelle représentée par ce référentiel (issue #209). */
const FUNCTION: PlanningFunction = 'encadrant';
const TAG = 'encadrant';

interface Encadrant {
  id?: number;
  nom: string;
  telephone?: string;
  indisponibilites?: OfficielIndisponibilite[];
}

interface EncadrantsData {
  encadrants: Encadrant[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function serialize(user: UserEntity): Encadrant {
  return {
    id: user.id,
    nom: user.nom,
    telephone: user.telephone ? user.telephone : undefined,
    indisponibilites: normalizeIndisponibilites(user.indisponibilites),
  };
}

async function findAllEncadrants(
  db: Awaited<ReturnType<typeof getDb>>,
  clubId: string,
  { activeOnly = false }: { activeOnly?: boolean } = {},
): Promise<UserEntity[]> {
  const repo = db.getRepository<UserEntity>('User');
  const users = await repo.find({ where: { clubId }, order: { nom: 'ASC' } });
  return users
    .filter((user) => normalizePlanningFunctions(user.planningFunctions).includes(FUNCTION))
    .filter((user) => !activeOnly || user.active);
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    // Issue #206 : masque par défaut les dirigeants désactivés du référentiel de sélection.
    const all = await findAllEncadrants(db, auth.user.clubId, { activeOnly: true });
    return NextResponse.json({ encadrants: all.map(serialize) } satisfies EncadrantsData);
  } catch (error) {
    console.error('Error reading encadrants from DB:', error);
    return NextResponse.json({ error: 'Failed to load encadrants' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const { oldNom, nom, indisponibilites } = body;
    const targetOldNom = oldNom && typeof oldNom === 'string' ? oldNom : nom;

    if (!targetOldNom || typeof targetOldNom !== 'string' || targetOldNom.trim() === '') {
      return NextResponse.json({ error: 'L\'ancien nom de l\'encadrant est requis' }, { status: 400 });
    }
    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom de l\'encadrant est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const clubId = auth.user.clubId;
    const encadrants = await findAllEncadrants(db, clubId);
    const encadrant = encadrants.find((item) => normalize(item.nom) === normalize(targetOldNom));
    if (!encadrant) return NextResponse.json({ error: 'Encadrant non trouvé' }, { status: 404 });

    const existingWithSameName = encadrants.find(
      (item) => item.id !== encadrant.id && normalize(item.nom) === normalize(nom),
    );
    if (existingWithSameName) {
      return NextResponse.json({ error: 'Un encadrant avec ce nom existe déjà' }, { status: 400 });
    }

    encadrant.nom = nom.trim();
    encadrant.telephone = await applyTelephoneGateAndMeta(db, {
      user: encadrant,
      clubId,
      category: 'encadrant',
      recordedByUserId: auth.user.id,
      body,
    });
    if (Object.prototype.hasOwnProperty.call(body, 'indisponibilites')) {
      const normalized = normalizeIndisponibilites(indisponibilites);
      encadrant.indisponibilites = normalized.length > 0 ? normalized : null;
    }
    await repo.save(encadrant);

    const all = await findAllEncadrants(db, clubId);
    return NextResponse.json({ success: true, data: { encadrants: all.map(serialize) } satisfies EncadrantsData });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    console.error('Error updating encadrants in DB:', error);
    return NextResponse.json({ error: 'Failed to update encadrants' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const { nom, telephone, indisponibilites } = body;
    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom de l\'encadrant est requis' }, { status: 400 });
    }

    const db = await getDb();
    const clubId = auth.user.clubId;
    const encadrants = await findAllEncadrants(db, clubId);
    const existing = encadrants.find((item) => normalize(item.nom) === normalize(nom));
    if (existing) return NextResponse.json({ error: 'Un encadrant avec ce nom existe déjà' }, { status: 400 });

    const resolvedTelephone = normalizeTelephone(telephone);
    const provenance = parseProvenance(body.provenance);
    const purpose = parsePurpose(body.purpose);
    assertTelephoneAllowed({ telephone: resolvedTelephone, provenance });

    const normalized = normalizeIndisponibilites(indisponibilites);
    const email = await generatePlaceholderEmail(db, nom, TAG);
    const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
    await db.transaction(async (manager) => {
      const saved = await manager.getRepository<UserEntity>('User').save({
        clubId,
        email,
        passwordHash,
        nom: nom.trim(),
        accessRole: 'dirigeant',
        planningFunctions: [FUNCTION],
        active: true,
        // Profil sans accès (issue #204) : pas d'identifiants connus, activation
        // uniquement via une invitation ciblant ce profil.
        claimedAt: null,
        telephone: resolvedTelephone,
        indisponibilites: normalized.length > 0 ? normalized : null,
        icalToken: randomBytes(24).toString('hex'),
      });
      await upsertContactMeta(manager, {
        userId: saved.id,
        clubId,
        category: 'encadrant',
        provenance,
        purpose,
        recordedByUserId: auth.user.id,
      });
    });

    const all = await findAllEncadrants(db, clubId);
    return NextResponse.json({ success: true, data: { encadrants: all.map(serialize) } satisfies EncadrantsData });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    console.error('Error adding encadrant in DB:', error);
    return NextResponse.json({ error: 'Failed to add encadrant' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const { searchParams } = new URL(request.url);
    const nom = searchParams.get('nom');
    if (!nom || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom de l\'encadrant est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const clubId = auth.user.clubId;
    const encadrants = await findAllEncadrants(db, clubId);
    const encadrant = encadrants.find((item) => normalize(item.nom) === normalize(nom));
    if (!encadrant) return NextResponse.json({ error: 'Encadrant non trouvé' }, { status: 404 });

    const remainingFunctions = normalizePlanningFunctions(encadrant.planningFunctions)
      .filter((planningFunction) => planningFunction !== FUNCTION);
    // Un compte qui garde une autre fonction (ou un accès administrateur) n'est pas
    // supprimé : seule la fonction correspondant à ce référentiel lui est retirée.
    if (remainingFunctions.length === 0 && encadrant.accessRole !== 'admin') {
      await repo.remove(encadrant);
    } else {
      encadrant.planningFunctions = remainingFunctions;
      await repo.save(encadrant);
    }
    const all = await findAllEncadrants(db, clubId);
    return NextResponse.json({ success: true, data: { encadrants: all.map(serialize) } satisfies EncadrantsData });
  } catch (error) {
    console.error('Error deleting encadrant in DB:', error);
    return NextResponse.json({ error: 'Failed to delete encadrant' }, { status: 500 });
  }
}
