import { createHash, randomBytes } from 'node:crypto';

/**
 * Jeton iCal personnel (issue #13) : identifie l'abonné auprès de
 * `/api/ical/[token]` sans session (le flux est consommé par un client
 * calendrier tiers). Seule son empreinte SHA-256 (`icalTokenHash`) est
 * stockée — voir `app/lib/db/migrations/schema-migrations.ts` (migration
 * `0041`) pour la migration des jetons existants et `docs/database-migrations.md`
 * pour la stratégie de transition.
 *
 * Le jeton brut n'est donc récupérable qu'au moment de sa génération : il est
 * renvoyé une seule fois par `/api/users/[id]/regenerate-ical-token` (POST) et
 * n'est plus jamais restitué ensuite — comme une clé d'API. `GET
 * /api/planning/ical-link` n'expose que des métadonnées (date de création),
 * jamais le jeton ni son empreinte.
 *
 * Une empreinte simple (SHA-256, sans poivre applicatif) suffit ici — à la
 * différence des jetons de session (`session-token.ts`, HMAC + poivre) : le
 * jeton fait 24 octets aléatoires (192 bits d'entropie), largement au-delà de
 * ce qu'une attaque hors ligne peut épuiser même sans poivre, et ce choix
 * reprend le précédent déjà établi pour les jetons d'invitation
 * (`invitation-token-hash.ts`, migration `0013`).
 */

/** 24 octets aléatoires en hexadécimal (48 caractères) — format historique inchangé. */
export function generateIcalToken(): string {
  return randomBytes(24).toString('hex');
}

/** Empreinte SHA-256 du jeton, stockée en base au lieu de la valeur brute. */
export function hashIcalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedIcalToken {
  /** Jeton brut — à restituer à l'appelant sans jamais être persisté. */
  token: string;
  icalTokenHash: string;
  icalTokenCreatedAt: Date;
}

/** Émet un nouveau jeton iCal (génération ou régénération). */
export function issueIcalToken(): IssuedIcalToken {
  const token = generateIcalToken();
  return { token, icalTokenHash: hashIcalToken(token), icalTokenCreatedAt: new Date() };
}

/** Colonnes représentant l'absence de flux iCal actif (révocation). */
export const REVOKED_ICAL_TOKEN: { icalTokenHash: null; icalTokenCreatedAt: null } = {
  icalTokenHash: null,
  icalTokenCreatedAt: null,
};
