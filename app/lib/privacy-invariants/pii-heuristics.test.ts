import { describe, expect, it } from 'vitest';
import { findRealisticPii, isClean } from './pii-heuristics';
import { forbiddenSentinelBundle, sentinelEmail, sentinelPhone } from './sentinel-factory';

describe('findRealisticPii (issue #41)', () => {
  it('laisse passer les domaines et numéros de test conventionnels du dépôt', () => {
    expect(isClean('Contact: test-user@example.com')).toBe(true);
    expect(isClean('Contact: user@example.test')).toBe(true);
    expect(isClean('Téléphone : 0600000000')).toBe(true);
    expect(isClean('Téléphone : 06 00 00 00 00')).toBe(true);
    expect(isClean(sentinelEmail())).toBe(true);
    expect(isClean(sentinelPhone())).toBe(true);
    expect(isClean(JSON.stringify(forbiddenSentinelBundle('scan')))).toBe(true);
  });

  it('détecte un e-mail à domaine réaliste', () => {
    const findings = findRealisticPii('Contact: jean.dupont@gmail.com');
    expect(findings).toEqual([{ kind: 'email', id: 'realistic-email-domain', value: 'jean.dupont@gmail.com' }]);
  });

  it('détecte un numéro de téléphone français réaliste (non placeholder)', () => {
    const findings = findRealisticPii('Portable: 06 12 34 56 78');
    expect(findings.some((f) => f.kind === 'phone')).toBe(true);
  });

  it('détecte les formats de secrets de fournisseurs connus', () => {
    expect(findRealisticPii('AKIAABCDEFGHIJKLMNOP').some((f) => f.id === 'aws-access-key')).toBe(true);
    expect(findRealisticPii('ghp_abcdefghijklmnopqrstuvwxyz0123456789').some((f) => f.id === 'github-token')).toBe(true);
    expect(findRealisticPii('sk_live_abcdefghijklmnop').some((f) => f.id === 'stripe-live-key')).toBe(true);
    expect(findRealisticPii('-----BEGIN RSA PRIVATE KEY-----').some((f) => f.id === 'private-key-block')).toBe(true);
  });

  it('ne signale rien sur un texte vide ou neutre', () => {
    expect(isClean('')).toBe(true);
    expect(isClean('Entraînement du mardi, catégorie U13.')).toBe(true);
  });
});
