import { createHash, randomBytes } from 'node:crypto';

/**
 * Jetons d'invitation (issue #271) : le jeton brut n'est jamais stocké en base,
 * seule son empreinte SHA-256 l'est — même principe que les jetons de
 * réinitialisation de mot de passe et de partage public.
 *
 * 24 octets (48 hex) volontairement distincts d'une empreinte SHA-256 (64 hex)
 * pour que `resolveInvitationLookupId` puisse encore distinguer jeton brut et id.
 */
export function newInvitationToken(): string {
  return randomBytes(24).toString('hex');
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Résout le paramètre URL admin (jeton brut ou empreinte déjà hashée — issue #378). */
export function resolveInvitationLookupId(token: string): string {
  const trimmed = token.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  return hashInvitationToken(trimmed);
}

/** Jeton de contexte d'échange (cookie httpOnly), distinct du jeton d'URL (issue #34). */
export function newInvitationContextToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashInvitationContextToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Durée de vie du contexte d'échange après validation de l'URL (issue #34). */
export const INVITATION_CONTEXT_TTL_MS = 15 * 60 * 1000;

/** Plafond d'expiration d'une invitation (issue #34) : plus de 365 jours. */
export const MAX_INVITATION_EXPIRES_IN_DAYS = 14;
export const DEFAULT_INVITATION_EXPIRES_IN_DAYS = 7;

/** Délai plancher pour uniformiser les réponses GET publiques (issue #34). */
export const INVITATION_PUBLIC_LOOKUP_MIN_MS = 40;

export async function padToMinimumDuration(startedAtMs: number, minMs = INVITATION_PUBLIC_LOOKUP_MIN_MS): Promise<void> {
  const remaining = minMs - (Date.now() - startedAtMs);
  if (remaining > 0) {
    await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

/**
 * Masque une adresse pour la phase de validation publique : premier caractère
 * du local et du domaine, TLD conservé. Jamais l'adresse complète (issue #34).
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return '***';
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const domainName = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  const localMask = `${local.charAt(0)}***`;
  const domainMask = `${domainName.charAt(0) || '*'}***`;
  return `${localMask}@${domainMask}${tld}`;
}
