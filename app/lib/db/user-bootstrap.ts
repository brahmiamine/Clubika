import { logWarn } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { DataSource } from 'typeorm';
import { UserEntity } from './schemas';
import { hashPassword } from '@/lib/auth/password';

function isDuplicateEntryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  return candidate.code === 'ER_DUP_ENTRY'
    || candidate.errno === 1062
    || (typeof candidate.message === 'string' && candidate.message.includes('Duplicate entry'));
}

/**
 * Variables documentées (README, CI) : BOOTSTRAP_SUPERADMIN_EMAIL / BOOTSTRAP_SUPERADMIN_PASSWORD.
 * Les anciens noms BOOTSTRAP_ADMIN_* restent acceptés en repli le temps de la transition,
 * avec un avertissement de dépréciation.
 */
function readBootstrapCredentials(): { email: string; password: string } | null {
  const email = (process.env.BOOTSTRAP_SUPERADMIN_EMAIL ?? process.env.BOOTSTRAP_ADMIN_EMAIL)?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_SUPERADMIN_PASSWORD ?? process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!process.env.BOOTSTRAP_SUPERADMIN_EMAIL && process.env.BOOTSTRAP_ADMIN_EMAIL) {
    logWarn('app.unhandled', 
      '[bootstrap] BOOTSTRAP_ADMIN_EMAIL/BOOTSTRAP_ADMIN_PASSWORD sont dépréciés : '
      + 'renommez-les en BOOTSTRAP_SUPERADMIN_EMAIL/BOOTSTRAP_SUPERADMIN_PASSWORD.',
    );
  }
  return email && password ? { email, password } : null;
}

export async function ensureAdminBootstrap(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository<UserEntity>('User');
  const count = await repo.count();
  if (count > 0) return;

  const credentials = readBootstrapCredentials();
  if (!credentials) {
    logWarn('app.unhandled', 
      '[bootstrap] Aucun utilisateur en base et BOOTSTRAP_SUPERADMIN_EMAIL/BOOTSTRAP_SUPERADMIN_PASSWORD ne sont pas définis — personne ne peut se connecter.',
    );
    return;
  }
  const { email, password } = credentials;

  // Plusieurs workers/tests peuvent initialiser la même base en parallèle.
  // Recheck by the unique email before the expensive hash, then tolerate the
  // unique-key race if another worker wins between this check and INSERT.
  if (await repo.findOneBy({ email })) return;

  const passwordHash = await hashPassword(password);
  try {
    await repo.save({
      clubId: process.env.APP_CLUB_ID || 'afp',
      email,
      passwordHash,
      nom: 'Admin',
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      // Compte bootstrap : accès actif immédiat (issue #204).
      claimedAt: new Date(),
      icalToken: randomBytes(24).toString('hex'),
    });
  } catch (error) {
    if (isDuplicateEntryError(error) && await repo.findOneBy({ email })) return;
    throw error;
  }

  logWarn('app.unhandled', 
    '[bootstrap] Administrateur initial créé depuis BOOTSTRAP_SUPERADMIN_EMAIL. Pensez à retirer ces variables une fois la première connexion effectuée.',
  );
}
