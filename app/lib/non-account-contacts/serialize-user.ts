import type { UserEntity } from '@/lib/db/schemas';
import { isClosedAccount } from '@/lib/account-closure/constants';
import { maskTelephone } from './format';

export function serializeManagedUser(user: UserEntity, options?: { revealPhone?: boolean }) {
  const closed = isClosedAccount(user);
  const unclaimed = user.claimedAt == null;
  const reveal = options?.revealPhone === true;
  const mask = !closed && unclaimed && !reveal;
  return {
    id: user.id,
    email: closed ? '' : user.email,
    nom: user.nom,
    accessRole: user.accessRole,
    planningFunctions: user.planningFunctions,
    active: user.active,
    telephone: closed ? null : (mask ? maskTelephone(user.telephone) : user.telephone),
    telephoneMasked: Boolean(mask && user.telephone),
    claimedAt: user.claimedAt,
    hasAccess: user.claimedAt != null && !closed,
    closedAt: user.closedAt,
    closureRequestedAt: user.closureRequestedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export function wantsRevealedPhone(url: string): boolean {
  return new URL(url).searchParams.get('revealPhone') === '1';
}
