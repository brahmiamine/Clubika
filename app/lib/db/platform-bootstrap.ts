import { logWarn } from '@/lib/observability/log';
import { DataSource } from 'typeorm';
import { PlatformAdminEntity } from './schemas';
import { hashPassword } from '@/lib/auth/password';
import { recordPrivilegedAuthEvent } from '@/lib/auth/privileged-auth-journal';

function isDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  return candidate.code === 'ER_DUP_ENTRY'
    || candidate.errno === 1062
    || (typeof candidate.message === 'string' && candidate.message.includes('Duplicate entry'));
}

function productionDualControlMissing(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  return !process.env.PLATFORM_BOOTSTRAP_APPROVAL?.trim();
}

export async function ensurePlatformAdminBootstrap(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository<PlatformAdminEntity>('PlatformAdmin');
  const count = await repo.count();
  if (count > 0) return;

  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  if (!email || !password) {
    logWarn('app.unhandled', 
      '[bootstrap] Aucun administrateur de plateforme en base et PLATFORM_ADMIN_EMAIL/PLATFORM_ADMIN_PASSWORD ne sont pas définis — personne ne peut se connecter à /plateforme.',
    );
    return;
  }

  if (productionDualControlMissing()) {
    logWarn('app.unhandled', 
      '[bootstrap] Bootstrap plateforme refusé : PLATFORM_BOOTSTRAP_APPROVAL est obligatoire en production (double contrôle, issue #32).',
    );
    return;
  }

  if (await repo.findOneBy({ email })) return;

  const passwordHash = await hashPassword(password);
  try {
    await repo.save({
      email,
      passwordHash,
      nom: 'Administrateur plateforme',
      active: true,
      totpSecretEncrypted: null,
      totpEnrolledAt: null,
    });
  } catch (error) {
    if (isDuplicateEntryError(error) && await repo.findOneBy({ email })) return;
    throw error;
  }

  try {
    await recordPrivilegedAuthEvent(dataSource, {
      action: 'platform-bootstrap',
      actorType: 'system',
      email,
    });
  } catch (error) {
    logWarn('app.unhandled', '[bootstrap] Journal bootstrap plateforme indisponible', error);
  }

  logWarn(
    'app.unhandled',
    '[bootstrap] Administrateur de plateforme initial créé depuis PLATFORM_ADMIN_EMAIL. Pensez à retirer ces variables (et PLATFORM_BOOTSTRAP_APPROVAL) une fois la première connexion et l\'enrôlement MFA effectués.',
  );
}
