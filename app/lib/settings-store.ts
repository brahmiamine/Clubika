import type { DataSource, EntityManager } from 'typeorm';
import {
  APP_SETTINGS_META_KEY,
  DEFAULT_APP_SETTINGS,
  normalizeAppSettings,
  type AppSettings,
  type PlanningFeatureFlags,
} from './settings';
import type { AppMetaEntity, ClubTenantEntity } from './db/schemas';
import { decryptSecret, encryptSecret } from './crypto/secret-box';

type Queryable = DataSource | EntityManager;

function tenantToSettings(tenant: ClubTenantEntity): AppSettings {
  let features: unknown = {};
  try {
    features = JSON.parse(tenant.featuresJson || '{}');
  } catch {
    features = {};
  }
  return normalizeAppSettings({
    clubName: tenant.name,
    clubAbbreviation: tenant.abbreviation,
    clubDescription: tenant.description,
    clubLogo: tenant.logo,
    matchesUrlKey: tenant.matchesUrlKey,
    scraperClubName: tenant.scraperClubName,
    themeMode: tenant.themeMode,
    primaryColor: tenant.primaryColor,
    accentColor: tenant.secondaryColor,
    timeZone: tenant.timeZone,
    smtp: {
      host: tenant.smtpHost ?? '',
      port: tenant.smtpPort,
      secure: tenant.smtpSecure,
      user: tenant.smtpUser ?? '',
      fromEmail: tenant.smtpFromEmail ?? '',
      fromName: tenant.smtpFromName ?? '',
      passwordSet: !!tenant.smtpPasswordEncrypted,
    },
    features,
  });
}

/**
 * Migration douce depuis l'ancienne ligne singleton `app_meta[app_settings_v1]`
 * (une seule config pour tout le déploiement) vers la ligne du club courant.
 * Ne s'applique qu'au club configuré par APP_CLUB_ID, seul club qui a pu avoir
 * une config sous l'ancien schéma.
 */
async function legacySettingsFor(db: Queryable, clubId: string): Promise<AppSettings | null> {
  if (clubId !== (process.env.APP_CLUB_ID || 'afp')) return null;
  const row = await db.getRepository<AppMetaEntity>('AppMeta').findOne({ where: { key: APP_SETTINGS_META_KEY } });
  if (!row?.value) return null;
  try {
    return normalizeAppSettings(JSON.parse(row.value) as unknown);
  } catch {
    return null;
  }
}

async function getOrCreateTenant(db: Queryable, clubId: string): Promise<ClubTenantEntity> {
  const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
  const existing = await repo.findOneBy({ id: clubId });
  if (existing) return existing;

  const legacy = await legacySettingsFor(db, clubId);
  const seed = legacy ?? DEFAULT_APP_SETTINGS;
  const created = repo.create({
    id: clubId,
    name: seed.clubName,
    abbreviation: seed.clubAbbreviation,
    description: seed.clubDescription,
    logo: seed.clubLogo,
    themeMode: seed.themeMode,
    primaryColor: seed.primaryColor,
    secondaryColor: seed.accentColor,
    timeZone: seed.timeZone,
    matchesUrlKey: seed.matchesUrlKey,
    scraperClubName: seed.scraperClubName,
    featuresJson: JSON.stringify(seed.features),
    smtpHost: seed.smtp.host || null,
    smtpPort: seed.smtp.port,
    smtpSecure: seed.smtp.secure,
    smtpUser: seed.smtp.user || null,
    smtpPasswordEncrypted: null,
    smtpFromEmail: seed.smtp.fromEmail || null,
    smtpFromName: seed.smtp.fromName || null,
    active: true,
  });
  try {
    return await repo.save(created);
  } catch {
    // Course entre deux requêtes concurrentes créant la même ligne : on relit.
    const concurrent = await repo.findOneBy({ id: clubId });
    if (concurrent) return concurrent;
    throw new Error(`Impossible de créer la configuration du club ${clubId}`);
  }
}

export async function readAppSettings(db: Queryable, clubId: string): Promise<AppSettings> {
  const tenant = await getOrCreateTenant(db, clubId);
  return tenantToSettings(tenant);
}

/**
 * Lecture sans effet de bord : ne crée ni tenant, ni paramètres.
 * Retourne null si le club n'existe pas ou n'est pas actif.
 */
export async function readExistingActiveAppSettings(
  db: Queryable,
  clubId: string,
): Promise<AppSettings | null> {
  const tenant = await db.getRepository<ClubTenantEntity>('ClubTenant').findOneBy({ id: clubId });
  if (!tenant?.active) return null;
  return tenantToSettings(tenant);
}

export async function saveAppSettings(
  db: Queryable,
  clubId: string,
  input: unknown,
  smtpPassword?: string | null,
): Promise<AppSettings> {
  return updateAppSettings(db, clubId, () => input, smtpPassword);
}

export async function updateAppSettings(
  db: Queryable,
  clubId: string,
  update: (current: AppSettings) => unknown,
  smtpPassword?: string | null,
): Promise<AppSettings> {
  const run = async (manager: EntityManager): Promise<AppSettings> => {
    const repo = manager.getRepository<ClubTenantEntity>('ClubTenant');
    const tenant = await getOrCreateTenant(manager, clubId);
    const current = tenantToSettings(tenant);
    const settings = normalizeAppSettings(update(current));

    tenant.name = settings.clubName;
    tenant.abbreviation = settings.clubAbbreviation;
    tenant.description = settings.clubDescription;
    tenant.logo = settings.clubLogo;
    tenant.themeMode = settings.themeMode;
    tenant.primaryColor = settings.primaryColor;
    tenant.secondaryColor = settings.accentColor;
    tenant.timeZone = settings.timeZone;
    tenant.matchesUrlKey = settings.matchesUrlKey;
    tenant.scraperClubName = settings.scraperClubName;
    tenant.featuresJson = JSON.stringify(settings.features);
    tenant.smtpHost = settings.smtp.host || null;
    tenant.smtpPort = settings.smtp.port;
    tenant.smtpSecure = settings.smtp.secure;
    tenant.smtpUser = settings.smtp.user || null;
    tenant.smtpFromEmail = settings.smtp.fromEmail || null;
    tenant.smtpFromName = settings.smtp.fromName || null;
    if (smtpPassword === null) {
      tenant.smtpPasswordEncrypted = null;
    } else if (typeof smtpPassword === 'string' && smtpPassword.length > 0) {
      tenant.smtpPasswordEncrypted = encryptSecret(smtpPassword);
    }
    await repo.save(tenant);
    return tenantToSettings(tenant);
  };

  return 'transaction' in db ? db.transaction(run) : run(db);
}

export async function getSmtpPassword(db: Queryable, clubId: string): Promise<string | null> {
  const tenant = await db.getRepository<ClubTenantEntity>('ClubTenant').findOneBy({ id: clubId });
  if (!tenant?.smtpPasswordEncrypted) return null;
  return decryptSecret(tenant.smtpPasswordEncrypted);
}

export async function isPlanningFeatureEnabled(
  db: Queryable,
  clubId: string,
  feature: keyof PlanningFeatureFlags,
): Promise<boolean> {
  return (await readAppSettings(db, clubId)).features[feature];
}

export class PlanningFeatureDisabledError extends Error {
  constructor(public readonly feature: keyof PlanningFeatureFlags) {
    super(`La fonctionnalité « ${feature} » est désactivée par l'administrateur.`);
    this.name = 'PlanningFeatureDisabledError';
  }
}

export async function requirePlanningFeature(
  db: Queryable,
  clubId: string,
  feature: keyof PlanningFeatureFlags,
): Promise<void> {
  if (!(await isPlanningFeatureEnabled(db, clubId, feature))) {
    throw new PlanningFeatureDisabledError(feature);
  }
}
