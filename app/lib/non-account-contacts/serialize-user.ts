import type { UserEntity } from '@/lib/db/schemas';
import { maskTelephone } from './format';

export function serializeManagedUser(user: UserEntity, options?: { revealPhone?: boolean }) {
  const unclaimed = user.claimedAt == null;
  const reveal = options?.revealPhone === true;
  const mask = unclaimed && !reveal;
  return {
    id: user.id,
    email: user.email,
    nom: user.nom,
    accessRole: user.accessRole,
    planningFunctions: user.planningFunctions,
    active: user.active,
    telephone: mask ? maskTelephone(user.telephone) : user.telephone,
    telephoneMasked: Boolean(mask && user.telephone),
    claimedAt: user.claimedAt,
    hasAccess: user.claimedAt != null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function wantsRevealedPhone(url: string): boolean {
  return new URL(url).searchParams.get('revealPhone') === '1';
}
