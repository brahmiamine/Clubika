import { createHash } from 'node:crypto';

/**
 * Politique de mot de passe (issue #32) : longueur et mots de passe compromis,
 * sans règles de complexité arbitraires (majuscule / chiffre / symbole).
 * Les gestionnaires de mots de passe et les phrases de passe sont acceptés.
 */

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-policy-constants';

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

/** Liste locale courte de secrets trop courants — jamais de données personnelles. */
const LOCAL_COMPROMISED = new Set([
  'password',
  'password123',
  'password1234',
  '123456789012',
  '12345678',
  'qwertyuiop',
  'qwerty123456',
  'letmein12345',
  'adminadmin12',
  'welcome12345',
  'iloveyou1234',
  'football1234',
  'monkeymonkey',
  'azertyuiop12',
  'motdepasse12',
  'changeme1234',
]);

export type PasswordPolicyFailure = {
  ok: false;
  error: string;
};

export type PasswordPolicySuccess = { ok: true };

export type PasswordPolicyResult = PasswordPolicyFailure | PasswordPolicySuccess;

function compromisedCheckMode(): 'off' | 'local' | 'hibp' {
  const raw = (process.env.COMPROMISED_PASSWORD_CHECK ?? 'local').trim().toLowerCase();
  if (raw === 'off' || raw === 'hibp' || raw === 'local') return raw;
  return 'local';
}

function looksLikeLocallyCompromised(password: string): boolean {
  const compact = password.toLowerCase().replace(/\s+/g, '');
  if (LOCAL_COMPROMISED.has(compact)) return true;
  if (LOCAL_COMPROMISED.has(password.toLowerCase())) return true;
  return false;
}

/**
 * k-anonymity Have I Been Pwned (préfixe SHA-1). Le mot de passe n'est jamais
 * envoyé en clair. Désactivé par défaut hors `COMPROMISED_PASSWORD_CHECK=hibp`
 * (choix de prestataire à valider, issue #32 / #30).
 */
async function isPwnedByHibp(password: string): Promise<boolean | null> {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const body = await response.text();
    return body.split('\n').some((line) => line.split(':')[0]?.trim().toUpperCase() === suffix);
  } catch {
    return null;
  }
}

export async function evaluatePasswordPolicy(password: string): Promise<PasswordPolicyResult> {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères.`,
    };
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return {
      ok: false,
      error: `Le mot de passe ne doit pas dépasser ${PASSWORD_MAX_LENGTH} caractères.`,
    };
  }
  if (password.includes('\0')) {
    return { ok: false, error: 'Le mot de passe contient un caractère interdit.' };
  }

  const mode = compromisedCheckMode();
  if (mode !== 'off' && looksLikeLocallyCompromised(password)) {
    return {
      ok: false,
      error: 'Ce mot de passe est trop courant. Choisissez une phrase de passe plus longue.',
    };
  }
  if (mode === 'hibp') {
    const pwned = await isPwnedByHibp(password);
    if (pwned === true) {
      return {
        ok: false,
        error: 'Ce mot de passe apparaît dans une fuite connue. Choisissez-en un autre.',
      };
    }
  }
  return { ok: true };
}

export async function assertPasswordPolicy(password: string): Promise<string | null> {
  const result = await evaluatePasswordPolicy(password);
  return result.ok ? null : result.error;
}
