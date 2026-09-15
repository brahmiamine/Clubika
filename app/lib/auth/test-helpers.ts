import { randomBytes } from 'node:crypto';
import { getDb } from '@/lib/db';
import { UserEntity } from '@/lib/db/schemas';
import { hashPassword } from './password';
import { createSession } from './session';
import type { ClubAccessRole, PlanningFunction } from './roles';

export async function createTestUserAndSession(
  accessRole: ClubAccessRole,
  overrides?: Partial<UserEntity>,
  planningFunctions: PlanningFunction[] = [],
) {
  const db = await getDb();
  const userRepo = db.getRepository<UserEntity>('User');

  const user = await userRepo.save({
    clubId: process.env.APP_CLUB_ID || 'afp',
    email: `test-${accessRole}-${Date.now()}-${randomBytes(4).toString('hex')}@example.com`,
    passwordHash: await hashPassword('test-password-123'),
    nom: `Test ${accessRole}`,
    accessRole,
    planningFunctions,
    active: true,
    // Un utilisateur de test est un compte activé par défaut ; passer
    // `claimedAt: null` dans `overrides` pour simuler un profil sans accès.
    claimedAt: new Date(),
    icalToken: randomBytes(12).toString('hex'),
    ...overrides,
  });

  const { token } = await createSession(user.id);

  return {
    user,
    token,
    cleanup: async () => {
      await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :userId', { userId: user.id }).execute();
      await userRepo.delete({ id: user.id });
    },
  };
}

export function uniqueTestIp(): string {
  const n = randomBytes(2).readUInt16BE(0);
  return `198.51.${n >> 8}.${n & 255}`;
}

export function enableTrustedProxyHeaders(): () => void {
  const previous = process.env.TRUST_PROXY_HEADERS;
  process.env.TRUST_PROXY_HEADERS = 'true';
  return () => {
    if (previous === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = previous;
  };
}
