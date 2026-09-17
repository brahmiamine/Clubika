/**
 * Heuristiques de détection de données à caractère personnel réalistes (issue #41).
 *
 * Utilisées par la suite « privacy invariants » et dupliquées volontairement (sans
 * import croisé) dans `scripts/check-privacy-fixtures.mjs`, qui est un script Node
 * simple exécuté sans étape de compilation — voir le commentaire en tête de ce
 * script pour la justification. Toute évolution des règles doit être répercutée
 * dans les deux fichiers ; `pii-heuristics.test.ts` fait tourner les mêmes cas sur
 * ce module-ci pour éviter toute dérive silencieuse.
 *
 * Objectif : ne jamais faire échouer la CI sur les domaines/numéros de test déjà
 * conventionnels du dépôt (RFC 2606 `.test`/`.invalid`/`.example`, RFC 5737
 * 198.51.100.0/24, numéros ARCEP réservés aux tests), et échouer sur tout ce qui
 * ressemble à un vrai contact ou un vrai secret de fournisseur.
 */

export const SAFE_EMAIL_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'example.test',
  'example.invalid',
  'invalid.local',
  'clubika.invalid',
] as const;

const SAFE_EMAIL_DOMAIN_SUFFIXES = ['.test', '.invalid', '.example', '.localhost'];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Numéros français à 10 chiffres (mobile/fixe), espacés ou non.
const PHONE_RE = /\b0[1-9](?:[\s.-]?\d{2}){4}\b/g;

/** Blocs de test conventionnels du dépôt : jamais un abonné réel. */
const SAFE_PHONE_PREFIXES = ['0600000000', '0700000000', '0000000000', '0699000000'];

const SECRET_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-live-key', re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/ },
];

export interface PiiFinding {
  kind: 'email' | 'phone' | 'secret';
  id: string;
  value: string;
}

function isSafeEmail(email: string): boolean {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if ((SAFE_EMAIL_DOMAINS as readonly string[]).includes(domain)) return true;
  return SAFE_EMAIL_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix));
}

function isSafePhone(rawMatch: string): boolean {
  const digits = rawMatch.replace(/\D/g, '');
  if (SAFE_PHONE_PREFIXES.includes(digits)) return true;
  // Bloc entier réservé par sentinelPhone() (sentinel-factory.ts), pas seulement
  // le préfixe exact 0699000000 : chaque appel varie les 2 derniers chiffres pour
  // rester unique par test, tout en restant dans un bloc jamais attribué.
  if (/^0699000\d{3}$/.test(digits)) return true;
  // Numéro « placeholder » : un seul chiffre répété, ou suite strictement croissante.
  if (/^(\d)\1{9}$/.test(digits)) return true;
  if (digits === '0102030405' || digits === '0123456789') return true;
  return false;
}

/**
 * Retourne chaque occurrence qui ressemble à une vraie donnée personnelle ou un
 * vrai secret. Un tableau vide signifie « rien de suspect trouvé ».
 */
export function findRealisticPii(text: string): PiiFinding[] {
  const findings: PiiFinding[] = [];

  for (const match of text.matchAll(EMAIL_RE)) {
    const value = match[0];
    if (!isSafeEmail(value)) findings.push({ kind: 'email', id: 'realistic-email-domain', value });
  }

  for (const match of text.matchAll(PHONE_RE)) {
    const value = match[0];
    if (!isSafePhone(value)) findings.push({ kind: 'phone', id: 'realistic-phone-number', value });
  }

  for (const pattern of SECRET_PATTERNS) {
    const match = pattern.re.exec(text);
    if (match) findings.push({ kind: 'secret', id: pattern.id, value: match[0] });
  }

  return findings;
}

export function isClean(text: string): boolean {
  return findRealisticPii(text).length === 0;
}
