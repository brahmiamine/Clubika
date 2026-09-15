import { logWarn } from '@/lib/observability/log';
import { DataSource } from 'typeorm';
import { PlatformAdminEntity } from './schemas';
import { hashPassword } from '@/lib/auth/password';

function isDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  return candidate.code === 'ER_DUP_ENTRY'
    || candidate.errno === 1062
    || (typeof candidate.message === 'string' && candidate.message.includes('Duplicate entry'));
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

  // Plusieurs workers/tests peuvent initialiser la même base en parallèle.
  // Recheck by the unique email before the expensive hash, then tolerate the
  // unique-key race if another worker wins between this check and INSERT.
  if (await repo.findOneBy({ email })) return;

  const passwordHash = await hashPassword(password);
  try {
    await repo.save({
      email,
      passwordHash,
      nom: 'Administrateur plateforme',
      active: true,
    });
  } catch (error) {
    if (isDuplicateEntryError(error) && await repo.findOneBy({ email })) return;
    throw error;
  }

  logWarn('app.unhandled', 
    '[bootstrap] Administrateur de plateforme initial créé depuis PLATFORM_ADMIN_EMAIL. Pensez à retirer ces variables une fois la première connexion effectuée.',
  );
}
