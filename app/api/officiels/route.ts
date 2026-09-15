import { logError } from '@/lib/observability/log';
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
import { isClosedAccount } from '@/lib/account-closure/constants';

/** Fonction opérationnelle représentée par ce référentiel (issue #209). */
const FUNCTION: PlanningFunction = 'arbitre_club';
const TAG = 'officiel';

interface Officiel {
  id?: number;
  nom: string;
  telephone?: string;
  indisponibilites?: OfficielIndisponibilite[];
}

interface OfficielsData {
  officiels: Officiel[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function serialize(user: UserEntity): Officiel {
  return {
    id: user.id,
    nom: user.nom,
    telephone: user.telephone ? user.telephone : undefined,
    indisponibilites: normalizeIndisponibilites(user.indisponibilites),
  };
}

async function findAllOfficiels(
  db: Awaited<ReturnType<typeof getDb>>,
  clubId: string,
  { activeOnly = false }: { activeOnly?: boolean } = {},
): Promise<UserEntity[]> {
  const repo = db.getRepository<UserEntity>('User');
  const users = await repo.find({ where: { clubId }, order: { nom: 'ASC' } });
  return users
    .filter((user) => normalizePlanningFunctions(user.planningFunctions).includes(FUNCTION))
    .filter((user) => !isClosedAccount(user))
    .filter((user) => !activeOnly || user.active);
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    // Issue #206 : le référentiel utilisé pour sélectionner un arbitre club masque par
    // défaut les dirigeants désactivés, qui ne doivent plus être proposés pour une
    // nouvelle affectation.
    const all = await findAllOfficiels(db, auth.user.clubId, { activeOnly: true });
    return NextResponse.json({ officiels: all.map(serialize) } satisfies OfficielsData);
  } catch (error) {
    logError('app.unhandled', 'Error reading officiels from DB:', error);
    return NextResponse.json({ error: 'Failed to load officiels' }, { status: 500 });
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
      return NextResponse.json({ error: 'L\'ancien nom de l\'officiel est requis' }, { status: 400 });
    }
    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom de l\'officiel est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const clubId = auth.user.clubId;
    const officiels = await findAllOfficiels(db, clubId);
    const officiel = officiels.find((item) => normalize(item.nom) === normalize(targetOldNom));
    if (!officiel) return NextResponse.json({ error: 'Officiel non trouvé' }, { status: 404 });

    const existingWithSameName = officiels.find(
      (item) => item.id !== officiel.id && normalize(item.nom) === normalize(nom),
    );
    if (existingWithSameName) {
      return NextResponse.json({ error: 'Un officiel avec ce nom existe déjà' }, { status: 400 });
    }

    officiel.nom = nom.trim();
    officiel.telephone = await applyTelephoneGateAndMeta(db, {
      user: officiel,
      clubId,
      category: 'officiel',
      recordedByUserId: auth.user.id,
      body,
    });
    if (Object.prototype.hasOwnProperty.call(body, 'indisponibilites')) {
      const normalized = normalizeIndisponibilites(indisponibilites);
      officiel.indisponibilites = normalized.length > 0 ? normalized : null;
    }
    await repo.save(officiel);

    const all = await findAllOfficiels(db, clubId);
    return NextResponse.json({ success: true, data: { officiels: all.map(serialize) } satisfies OfficielsData });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    logError('app.unhandled', 'Error updating officiels in DB:', error);
    return NextResponse.json({ error: 'Failed to update officiels' }, { status: 500 });
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
      return NextResponse.json({ error: 'Le nom de l\'officiel est requis' }, { status: 400 });
    }

    const db = await getDb();
    const clubId = auth.user.clubId;
    const officiels = await findAllOfficiels(db, clubId);
    const existing = officiels.find((item) => normalize(item.nom) === normalize(nom));
    if (existing) return NextResponse.json({ error: 'Un officiel avec ce nom existe déjà' }, { status: 400 });

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
        category: 'officiel',
        provenance,
        purpose,
        recordedByUserId: auth.user.id,
      });
    });

    const all = await findAllOfficiels(db, clubId);
    return NextResponse.json({ success: true, data: { officiels: all.map(serialize) } satisfies OfficielsData });
  } catch (error) {
    const lifecycle = contactLifecycleResponse(error);
    if (lifecycle) return lifecycle;
    logError('app.unhandled', 'Error adding officiel in DB:', error);
    return NextResponse.json({ error: 'Failed to add officiel' }, { status: 500 });
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
      return NextResponse.json({ error: 'Le nom de l\'officiel est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const clubId = auth.user.clubId;
    const officiels = await findAllOfficiels(db, clubId);
    const officiel = officiels.find((item) => normalize(item.nom) === normalize(nom));
    if (!officiel) return NextResponse.json({ error: 'Officiel non trouvé' }, { status: 404 });

    const remainingFunctions = normalizePlanningFunctions(officiel.planningFunctions)
      .filter((planningFunction) => planningFunction !== FUNCTION);
    // Un compte qui garde une autre fonction (ou un accès administrateur) n'est pas
    // supprimé : seule la fonction correspondant à ce référentiel lui est retirée.
    if (remainingFunctions.length === 0 && officiel.accessRole !== 'admin') {
      await repo.remove(officiel);
    } else {
      officiel.planningFunctions = remainingFunctions;
      await repo.save(officiel);
    }
    const all = await findAllOfficiels(db, clubId);
    return NextResponse.json({ success: true, data: { officiels: all.map(serialize) } satisfies OfficielsData });
  } catch (error) {
    logError('app.unhandled', 'Error deleting officiel in DB:', error);
    return NextResponse.json({ error: 'Failed to delete officiel' }, { status: 500 });
  }
}
