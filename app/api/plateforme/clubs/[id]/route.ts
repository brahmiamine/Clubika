import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ClubTenantEntity } from '@/lib/db/schemas';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { readAppSettings } from '@/lib/settings-store';
import { revokeAllSessionsForClub } from '@/lib/auth/session';
import { platformClubWriteBlocked, serializeOffboarding } from '@/lib/tenant-offboarding/writable';

const MATCHES_URL_KEY_PATTERN = /^[a-z0-9-]*$/;
const MAX_SCRAPING_FIELD_LENGTH = 255;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const { id } = params instanceof Promise ? await params : params;
    const db = await getDb();
    const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const club = await repo.findOneBy({ id });
    if (!club) {
      return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
    }

    const settings = await readAppSettings(db, id);
    return NextResponse.json({
      club: {
        id: club.id,
        active: club.active,
        createdAt: club.createdAt,
        updatedAt: club.updatedAt,
        offboarding: serializeOffboarding(club),
        settings,
      },
    });
  } catch (error) {
    console.error('Error reading club tenant:', error);
    return NextResponse.json({ error: 'Impossible de charger le club' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const { id } = params instanceof Promise ? await params : params;
    const db = await getDb();
    const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const club = await repo.findOneBy({ id });
    if (!club) {
      return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
    }

    const body = await request.json();
    const { name, active, matchesUrlKey, scraperClubName } = body;
    const wasActive = club.active;

    const writeBlock = platformClubWriteBlocked(club);
    if (writeBlock && (name !== undefined || matchesUrlKey !== undefined || scraperClubName !== undefined || active === true)) {
      return NextResponse.json({ error: writeBlock }, { status: 409 });
    }
    if (writeBlock && active === false) {
      // Un club déjà gelé peut rester inactif ; on n'accepte pas d'autre mutation.
    }

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim() === '') {
        return NextResponse.json({ error: 'Le nom du club est requis' }, { status: 400 });
      }
      club.name = name.trim();
    }
    if (active !== undefined) {
      if (typeof active !== 'boolean') {
        return NextResponse.json({ error: 'Le statut actif doit être un booléen' }, { status: 400 });
      }
      club.active = active;
    }
    if (matchesUrlKey !== undefined) {
      if (typeof matchesUrlKey !== 'string') {
        return NextResponse.json({ error: 'matchesUrlKey doit être une chaîne de caractères' }, { status: 400 });
      }
      const normalizedMatchesUrlKey = matchesUrlKey.trim().toLowerCase();
      if (
        normalizedMatchesUrlKey.length > MAX_SCRAPING_FIELD_LENGTH
        || !MATCHES_URL_KEY_PATTERN.test(normalizedMatchesUrlKey)
      ) {
        return NextResponse.json(
          {
            error: 'matchesUrlKey doit contenir uniquement des lettres minuscules, chiffres et tirets (255 caractères maximum)',
          },
          { status: 400 },
        );
      }
      club.matchesUrlKey = normalizedMatchesUrlKey;
    }
    if (scraperClubName !== undefined) {
      if (typeof scraperClubName !== 'string') {
        return NextResponse.json({ error: 'scraperClubName doit être une chaîne de caractères' }, { status: 400 });
      }
      const normalizedScraperClubName = scraperClubName.trim();
      if (normalizedScraperClubName.length > MAX_SCRAPING_FIELD_LENGTH) {
        return NextResponse.json({ error: 'scraperClubName ne peut pas dépasser 255 caractères' }, { status: 400 });
      }
      club.scraperClubName = normalizedScraperClubName;
    }

    // Issue #221 : sans scraperClubName, la vérification d'identité du club scrapé est un
    // no-op silencieux — vérifié sur l'état final (les deux champs peuvent être patchés
    // indépendamment l'un de l'autre).
    if (club.matchesUrlKey && !club.scraperClubName) {
      return NextResponse.json(
        { error: 'scraperClubName est requis dès qu\'une source de scraping (matchesUrlKey) est configurée' },
        { status: 400 },
      );
    }

    await repo.save(club);

    if (wasActive && club.active === false) {
      await revokeAllSessionsForClub(club.id);
    }

    return NextResponse.json({
      success: true,
      club: {
        id: club.id,
        name: club.name,
        active: club.active,
        matchesUrlKey: club.matchesUrlKey,
        scraperClubName: club.scraperClubName,
        createdAt: club.createdAt,
        updatedAt: club.updatedAt,
      },
    });
  } catch (error) {
    console.error('Error updating club tenant:', error);
    return NextResponse.json({ error: 'Impossible de mettre à jour le club' }, { status: 500 });
  }
}
