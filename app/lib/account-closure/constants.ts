/**
 * Fermeture de compte (issue #11) : constantes d'anonymisation partagées.
 *
 * Le libellé d'affichage est figé par les critères d'acceptation. L'adresse de
 * substitution utilise le TLD réservé `.invalid` (RFC 2606) : elle n'est pas
 * routable et ne doit jamais être exposée dans l'UI ni les exports.
 */

export const ANONYMIZED_DISPLAY_NAME = 'Utilisateur supprimé';

/** Hash sentinelle : `verifyPassword` refuse tout schéma autre que `scrypt:`. */
export const CLOSED_PASSWORD_HASH = 'closed:revoked';

export const CLOSED_EMAIL_DOMAIN = 'invalid.local';

export function closedAccountEmail(userId: number): string {
  return `closed.${userId}@${CLOSED_EMAIL_DOMAIN}`;
}

export function isClosedAccount(user: { closedAt?: Date | string | null }): boolean {
  return user.closedAt != null && user.closedAt !== '';
}
