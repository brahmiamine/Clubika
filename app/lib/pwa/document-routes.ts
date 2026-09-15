const PRODUCT_PREFIXES = ['/login', '/mot-de-passe-oublie', '/reinitialiser', '/plateforme', '/inscription'];
const TOKEN_CLUB_PREFIXES = ['/partage'];

/** Landing, login et back-office : onglet Clubika, jamais le blason d’un club. */
export function usesAppProductDocumentHead(pathname: string): boolean {
  if (pathname === '/') return true;
  return PRODUCT_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Pages dont l’identité onglet vient du jeton (club invité / planning public). */
export function usesTokenClubDocumentHead(pathname: string): boolean {
  return TOKEN_CLUB_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
