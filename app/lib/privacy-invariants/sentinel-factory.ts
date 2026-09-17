/**
 * Fabrique de données sentinelles (issue #41).
 *
 * Toute valeur produite ici porte le marqueur `zzsentinel41` : jamais un nom, un
 * numéro ou un domaine réaliste. Le marqueur sert à la fois de donnée de test
 * unique (on peut vérifier son absence après un passage de frontière) et de
 * repère pour l'outil de scan (`scripts/check-privacy-fixtures.mjs`) — il utilise
 * exclusivement des domaines réservés aux tests (RFC 2606 : `.test`, `.invalid`)
 * et des numéros sans valeur d'appel réelle.
 *
 * Ne jamais remplacer ces valeurs par un nom, un numéro ou un domaine qui
 * ressemble à une vraie personne ou à un vrai fournisseur : c'est exactement ce
 * que ce test suite est censée empêcher.
 */

let counter = 0;

/** Identifiant unique par appel, pour ne jamais réutiliser la même donnée sentinelle deux fois. */
function nextId(): number {
  counter += 1;
  return counter;
}

export const SENTINEL_MARKER = 'zzsentinel41';

export function sentinelEmail(scope = 'contact'): string {
  return `${SENTINEL_MARKER}.${scope}.${nextId()}@example.test`;
}

/** Numéro non attribuable (plage TEST de l'ARCEP : 0699 000 000 n'est jamais un abonné réel). */
export function sentinelPhone(): string {
  return `06990000${String(nextId() % 100).padStart(2, '0')}`;
}

export function sentinelName(scope = 'Personne'): string {
  return `${SENTINEL_MARKER} ${scope} ${nextId()}`;
}

export function sentinelFreeText(scope = 'note'): string {
  return `${SENTINEL_MARKER} texte libre ${scope} #${nextId()} — ne doit franchir aucune frontière publique.`;
}

export function sentinelToken(): string {
  return `${SENTINEL_MARKER}-token-${nextId()}-0000000000000000000000000000000000000000000000000000000000`.slice(0, 64);
}

export function sentinelSecret(): string {
  return `${SENTINEL_MARKER}-secret-${nextId()}-do-not-leak`;
}

/** Adresse IP dans la plage documentation TEST-NET-2 (RFC 5737) : jamais routable. */
export function sentinelIp(): string {
  return `198.51.100.${nextId() % 255}`;
}

export function sentinelPushEndpoint(): string {
  return `https://push.example.test/${SENTINEL_MARKER}/${nextId()}`;
}

export function sentinelRawText(): string {
  return `${SENTINEL_MARKER} rawText brut #${nextId()} : contact direct, coordonnées personnelles.`;
}

export function sentinelClubId(scope = 'club'): string {
  return `${SENTINEL_MARKER}-${scope}-${nextId()}`;
}

export function sentinelAddress(): string {
  return `${nextId()} rue ${SENTINEL_MARKER}, 00000 Villefictive`;
}

/**
 * Ensemble de champs interdits, toutes catégories confondues (nom, email, téléphone,
 * texte libre, token, secret, IP, endpoint push, rawText, contenu supposé supprimé),
 * prêt à être vérifié en négatif contre le JSON sérialisé d'une frontière.
 */
export interface ForbiddenSentinelBundle {
  name: string;
  email: string;
  phone: string;
  freeText: string;
  token: string;
  secret: string;
  ip: string;
  pushEndpoint: string;
  rawText: string;
  deletedContent: string;
}

export function forbiddenSentinelBundle(scope: string): ForbiddenSentinelBundle {
  return {
    name: sentinelName(scope),
    email: sentinelEmail(scope),
    phone: sentinelPhone(),
    freeText: sentinelFreeText(scope),
    token: sentinelToken(),
    secret: sentinelSecret(),
    ip: sentinelIp(),
    pushEndpoint: sentinelPushEndpoint(),
    rawText: sentinelRawText(),
    deletedContent: `${SENTINEL_MARKER} contenu-supprime ${scope} #${nextId()}`,
  };
}

export function allForbiddenNeedles(bundle: ForbiddenSentinelBundle): string[] {
  return Object.values(bundle);
}
