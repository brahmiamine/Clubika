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

/** Fonction opérationnelle représentée par ce référentiel (issue #209). */
const FUNCTION: PlanningFunction = 'accompagnateur';
const TAG = 'accompagnateur';

interface Accompagnateur {
  id?: number;
  nom: string;
  telephone?: string;
  indisponibilites?: OfficielIndisponibilite[];
}

interface AccompagnateursData {
  accompagnateurs: Accompagnateur[];
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function serialize(user: UserEntity): Accompagnateur {
  return {
    id: user.id,
    nom: user.nom,
    telephone: user.telephone ? user.telephone : undefined,
    indisponibilites: normalizeIndisponibilites(user.indisponibilites),
  };
}

async function findAllAccompagnateurs(
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
    const all = await findAllAccompagnateurs(db, auth.user.clubId, { activeOnly: true });
    return NextResponse.json({ accompagnateurs: all.map(serialize) } satisfies AccompagnateursData);
  } catch (error) {
    logError('app.unhandled', 'Error reading accompagnateurs from DB:', error);
    return NextResponse.json({ error: 'Failed to load accompagnateurs' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const { oldNom, nom, telephone, indisponibilites } = body;
    const targetOldNom = oldNom && typeof oldNom === 'string' ? oldNom : nom;

    if (!targetOldNom || typeof targetOldNom !== 'string' || targetOldNom.trim() === '') {
      return NextResponse.json({ error: 'L\'ancien nom de l\'accompagnateur est requis' }, { status: 400 });
    }
    if (!nom || typeof nom !== 'string' || nom.trim() === '') {
      return NextResponse.json({ error: 'Le nom de l\'accompagnateur est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const clubId = auth.user.clubId;
    const accompagnateurs = await findAllAccompagnateurs(db, clubId);
    const accompagnateur = accompagnateurs.find((item) => normalize(item.nom) === normalize(targetOldNom));
    if (!accompagnateur) return NextResponse.json({ error: 'Accompagnateur non trouvé' }, { status: 404 });

    const existingWithSameName = accompagnateurs.find(
      (item) => item.id !== accompagnateur.id && normalize(item.nom) === normalize(nom),
    );
    if (existingWithSameName) {
      return NextResponse.json({ error: 'Un accompagnateur avec ce nom existe déjà' }, { status: 400 });
    }

    accompagnateur.nom = nom.trim();
    accompagnateur.telephone = telephone && typeof telephone === 'string' ? telephone.trim() || null : null;
    if (Object.prototype.hasOwnProperty.call(body, 'indisponibilites')) {
      const normalized = normalizeIndisponibilites(indisponibilites);
      accompagnateur.indisponibilites = normalized.length > 0 ? normalized : null;
    }
    await repo.save(accompagnateur);

    const all = await findAllAccompagnateurs(db, clubId);
    return NextResponse.json({ success: true, data: { accompagnateurs: all.map(serialize) } satisfies AccompagnateursData });
  } catch (error) {
    logError('app.unhandled', 'Error updating accompagnateurs in DB:', error);
    return NextResponse.json({ error: 'Failed to update accompagnateurs' }, { status: 500 });
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
      return NextResponse.json({ error: 'Le nom de l\'accompagnateur est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const clubId = auth.user.clubId;
    const accompagnateurs = await findAllAccompagnateurs(db, clubId);
    const existing = accompagnateurs.find((item) => normalize(item.nom) === normalize(nom));
    if (existing) return NextResponse.json({ error: 'Un accompagnateur avec ce nom existe déjà' }, { status: 400 });

    const normalized = normalizeIndisponibilites(indisponibilites);
    const email = await generatePlaceholderEmail(db, nom, TAG);
    const passwordHash = await hashPassword(randomBytes(24).toString('hex'));
    await repo.save({
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
      telephone: telephone && typeof telephone === 'string' ? telephone.trim() || null : null,
      indisponibilites: normalized.length > 0 ? normalized : null,
      icalToken: randomBytes(24).toString('hex'),
    });

    const all = await findAllAccompagnateurs(db, clubId);
    return NextResponse.json({ success: true, data: { accompagnateurs: all.map(serialize) } satisfies AccompagnateursData });
  } catch (error) {
    logError('app.unhandled', 'Error adding accompagnateur in DB:', error);
    return NextResponse.json({ error: 'Failed to add accompagnateur' }, { status: 500 });
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
      return NextResponse.json({ error: 'Le nom de l\'accompagnateur est requis' }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<UserEntity>('User');
    const clubId = auth.user.clubId;
    const accompagnateurs = await findAllAccompagnateurs(db, clubId);
    const accompagnateur = accompagnateurs.find((item) => normalize(item.nom) === normalize(nom));
    if (!accompagnateur) return NextResponse.json({ error: 'Accompagnateur non trouvé' }, { status: 404 });

    const remainingFunctions = normalizePlanningFunctions(accompagnateur.planningFunctions)
      .filter((planningFunction) => planningFunction !== FUNCTION);
    // Un compte qui garde une autre fonction (ou un accès administrateur) n'est pas
    // supprimé : seule la fonction correspondant à ce référentiel lui est retirée.
    if (remainingFunctions.length === 0 && accompagnateur.accessRole !== 'admin') {
      await repo.remove(accompagnateur);
    } else {
      accompagnateur.planningFunctions = remainingFunctions;
      await repo.save(accompagnateur);
    }
    const all = await findAllAccompagnateurs(db, clubId);
    return NextResponse.json({ success: true, data: { accompagnateurs: all.map(serialize) } satisfies AccompagnateursData });
  } catch (error) {
    logError('app.unhandled', 'Error deleting accompagnateur in DB:', error);
    return NextResponse.json({ error: 'Failed to delete accompagnateur' }, { status: 500 });
  }
}
