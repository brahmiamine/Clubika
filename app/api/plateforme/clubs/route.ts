import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ClubTenantEntity } from '@/lib/db/schemas';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { DEFAULT_APP_SETTINGS } from '@/lib/settings';

const CLUB_ID_PATTERN = /^[a-z0-9-]{2,64}$/;
const MATCHES_URL_KEY_PATTERN = /^[a-z0-9-]*$/;
const MAX_SCRAPING_FIELD_LENGTH = 255;

function serializeClub(club: ClubTenantEntity) {
  return {
    id: club.id,
    name: club.name,
    active: club.active,
    matchesUrlKey: club.matchesUrlKey,
    scraperClubName: club.scraperClubName,
    offboardingStatus: club.offboardingStatus ?? 'none',
    legalHoldActive: Boolean(club.legalHoldActive),
    createdAt: club.createdAt,
    updatedAt: club.updatedAt,
  };
}

const HEX_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_ABBREVIATION_LENGTH = 16;

function expandShortHex(value: string): string {
  if (value.length !== 4) return value.toLowerCase();
  const r = value[1] ?? '0';
  const g = value[2] ?? '0';
  const b = value[3] ?? '0';
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

function parseColor(value: unknown, field: string, fallback: string): { color: string } | { error: string } {
  if (value === undefined || value === null || value === '') {
    return { color: fallback };
  }
  if (typeof value !== 'string' || !HEX_COLOR_PATTERN.test(value.trim())) {
    return { error: `${field} doit être une couleur hexadécimale (#RGB ou #RRGGBB)` };
  }
  return { color: expandShortHex(value.trim()) };
}

function parseBranding(body: Record<string, unknown>) {
  const rawAbbreviation = body.abbreviation ?? body.clubAbbreviation;
  const rawLogo = body.logo ?? body.clubLogo;
  const rawPrimary = body.primaryColor;
  const rawSecondary = body.secondaryColor ?? body.accentColor;

  if (rawAbbreviation !== undefined && typeof rawAbbreviation !== 'string') {
    return { error: 'L\'abréviation du club doit être une chaîne de caractères' } as const;
  }
  const abbreviation = typeof rawAbbreviation === 'string'
    ? rawAbbreviation.trim().replace(/\s+/g, ' ').slice(0, MAX_ABBREVIATION_LENGTH)
    : '';
  if (!abbreviation) {
    return { error: 'L\'abréviation du club est requise' } as const;
  }

  if (rawLogo !== undefined && typeof rawLogo !== 'string') {
    return { error: 'Le logo du club doit être une chaîne de caractères' } as const;
  }
  const logo = typeof rawLogo === 'string' ? rawLogo.trim() : DEFAULT_APP_SETTINGS.clubLogo;

  const primary = parseColor(rawPrimary, 'primaryColor', DEFAULT_APP_SETTINGS.primaryColor);
  if ('error' in primary) return primary;
  const secondary = parseColor(rawSecondary, 'secondaryColor', DEFAULT_APP_SETTINGS.accentColor);
  if ('error' in secondary) return secondary;

  return {
    abbreviation,
    logo,
    primaryColor: primary.color,
    secondaryColor: secondary.color,
  } as const;
}

function parseScrapingConfig(body: Record<string, unknown>) {
  const rawMatchesUrlKey = body.matchesUrlKey;
  const rawScraperClubName = body.scraperClubName;

  if (rawMatchesUrlKey !== undefined && typeof rawMatchesUrlKey !== 'string') {
    return { error: 'matchesUrlKey doit être une chaîne de caractères' } as const;
  }
  if (rawScraperClubName !== undefined && typeof rawScraperClubName !== 'string') {
    return { error: 'scraperClubName doit être une chaîne de caractères' } as const;
  }

  const matchesUrlKey = typeof rawMatchesUrlKey === 'string' ? rawMatchesUrlKey.trim().toLowerCase() : '';
  const scraperClubName = typeof rawScraperClubName === 'string' ? rawScraperClubName.trim() : '';

  if (matchesUrlKey.length > MAX_SCRAPING_FIELD_LENGTH || !MATCHES_URL_KEY_PATTERN.test(matchesUrlKey)) {
    return {
      error: 'matchesUrlKey doit contenir uniquement des lettres minuscules, chiffres et tirets (255 caractères maximum)',
    } as const;
  }
  if (scraperClubName.length > MAX_SCRAPING_FIELD_LENGTH) {
    return { error: 'scraperClubName ne peut pas dépasser 255 caractères' } as const;
  }
  // Issue #221 : sans scraperClubName, la vérification d'identité du club scrapé
  // (assertScrapedClubIdentity) est un no-op silencieux — un club peut alors importer
  // sans le détecter les données d'un autre club exposé sur la même source de scraping.
  if (matchesUrlKey && !scraperClubName) {
    return { error: 'scraperClubName est requis dès qu\'une source de scraping (matchesUrlKey) est configurée' } as const;
  }

  return { matchesUrlKey, scraperClubName } as const;
}

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const db = await getDb();
    const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const clubs = await repo.find({ order: { name: 'ASC' } });
    return NextResponse.json({ clubs: clubs.map(serializeClub) });
  } catch (error) {
    console.error('Error listing club tenants:', error);
    return NextResponse.json({ error: 'Impossible de charger les clubs' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  try {
    const body = await request.json();
    const { id, name } = body;

    if (!id || typeof id !== 'string' || !CLUB_ID_PATTERN.test(id)) {
      return NextResponse.json(
        { error: 'L\'identifiant du club doit contenir entre 2 et 64 caractères (lettres minuscules, chiffres, tirets)' },
        { status: 400 },
      );
    }
    if (!name || typeof name !== 'string' || name.trim() === '') {
      return NextResponse.json({ error: 'Le nom du club est requis' }, { status: 400 });
    }

    const scrapingConfig = parseScrapingConfig(body as Record<string, unknown>);
    if ('error' in scrapingConfig) {
      return NextResponse.json({ error: scrapingConfig.error }, { status: 400 });
    }

    const branding = parseBranding(body as Record<string, unknown>);
    if ('error' in branding) {
      return NextResponse.json({ error: branding.error }, { status: 400 });
    }

    const db = await getDb();
    const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
    const existing = await repo.findOneBy({ id });
    if (existing) {
      return NextResponse.json({ error: 'Un club avec cet identifiant existe déjà' }, { status: 409 });
    }

    const club = repo.create({
      id,
      name: name.trim(),
      abbreviation: branding.abbreviation,
      description: DEFAULT_APP_SETTINGS.clubDescription,
      logo: branding.logo,
      themeMode: DEFAULT_APP_SETTINGS.themeMode,
      primaryColor: branding.primaryColor,
      secondaryColor: branding.secondaryColor,
      timeZone: DEFAULT_APP_SETTINGS.timeZone,
      matchesUrlKey: scrapingConfig.matchesUrlKey,
      scraperClubName: scrapingConfig.scraperClubName,
      featuresJson: JSON.stringify(DEFAULT_APP_SETTINGS.features),
      smtpHost: null,
      smtpPort: null,
      smtpSecure: false,
      smtpUser: null,
      smtpPasswordEncrypted: null,
      smtpFromEmail: null,
      smtpFromName: null,
      active: true,
      offboardingStatus: 'none',
      frozenAt: null,
      retentionUntil: null,
      purgedAt: null,
      legalHoldActive: false,
      legalHoldMotive: null,
      legalHoldScope: null,
      legalHoldExpiresAt: null,
      legalHoldApprovedBy: null,
      legalHoldCreatedAt: null,
    });

    try {
      await repo.save(club);
    } catch {
      const concurrent = await repo.findOneBy({ id });
      if (concurrent) {
        return NextResponse.json({ error: 'Un club avec cet identifiant existe déjà' }, { status: 409 });
      }
      throw new Error('Impossible de créer le club');
    }

    return NextResponse.json({ success: true, club: serializeClub(club) });
  } catch (error) {
    console.error('Error creating club tenant:', error);
    return NextResponse.json({ error: 'Impossible de créer le club' }, { status: 500 });
  }
}
