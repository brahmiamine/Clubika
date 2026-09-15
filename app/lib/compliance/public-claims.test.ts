import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_PUBLIC_CLAIM_PATTERNS,
  LANDING_CHAT_INTRO,
  LANDING_FAQ_ITEMS,
  LANDING_FEATURES,
  LANDING_SECURITY_ITEMS,
  PUBLIC_CLAIM_SURFACES,
  RETAINED_PUBLIC_CLAIMS,
} from './public-claims';

function readSurface(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

const FORBIDDEN_PHRASE_SAMPLES: Record<string, string> = {
  '100-legal': 'Produit 100 % légal dès le lancement',
  'conforme-rgpd': 'Clubika est conforme RGPD',
  'conformite-rgpd': 'Une conformité RGPD complète',
  'gdpr-compliant': 'This app is GDPR compliant',
  'entierement-securise': 'Un espace entièrement sécurisé',
  'totalement-securise': 'Hébergement totalement sécurisé',
  '100-secur': 'Plateforme 100 % sécurisée',
  '100-conforme': 'Offre 100 % conforme',
  'aucune-donnee-personnelle': 'Aucune donnée personnelle n’est collectée',
  'aucune-donnee-n-est': 'Aucune donnée n’est transmise à des tiers',
  'le-tout-chiffre': 'Messages, fichiers et sauvegardes : le tout chiffré au repos',
  'entierement-chiffre': 'Stockage entièrement chiffré',
  'limitent-calendrier': 'Les données exposées se limitent au calendrier',
  'limite-donnees-calendrier': 'Partage public limité aux données de calendrier',
};

describe('public claims allowlist (issue #38)', () => {
  it('fait échouer les formulations interdites sur un échantillon', () => {
    const ids = FORBIDDEN_PUBLIC_CLAIM_PATTERNS.map((item) => item.id);
    expect(ids.sort()).toEqual(Object.keys(FORBIDDEN_PHRASE_SAMPLES).sort());

    for (const { id, source } of FORBIDDEN_PUBLIC_CLAIM_PATTERNS) {
      const sample = FORBIDDEN_PHRASE_SAMPLES[id];
      expect(sample, id).toBeDefined();
      expect(new RegExp(source, 'iu').test(sample ?? ''), id).toBe(true);
    }
  });

  it('inventorie les surfaces publiques à surveiller', () => {
    expect(PUBLIC_CLAIM_SURFACES.length).toBeGreaterThanOrEqual(6);
    expect(PUBLIC_CLAIM_SURFACES).toContain('app/components/landing/LandingPage.tsx');
    expect(PUBLIC_CLAIM_SURFACES).toContain('README.md');
    expect(PUBLIC_CLAIM_SURFACES).toContain('app/lib/pwa/branding.ts');
  });

  it('rejette les formulations absolues ou non démontrées sur les surfaces publiques', () => {
    const violations: string[] = [];

    for (const relativePath of PUBLIC_CLAIM_SURFACES) {
      const source = readSurface(relativePath);
      for (const { id, source: patternSource } of FORBIDDEN_PUBLIC_CLAIM_PATTERNS) {
        const pattern = new RegExp(patternSource, 'iu');
        if (pattern.test(source)) {
          violations.push(`${relativePath} :: ${id}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('conserve uniquement des claims chiffrage et partage qualifiés, avec preuve', () => {
    expect(LANDING_SECURITY_ITEMS[0]?.copy).toMatch(/texte des messages de chat/i);
    expect(LANDING_SECURITY_ITEMS[0]?.copy).toMatch(/pièces jointes/i);
    expect(LANDING_SECURITY_ITEMS[0]?.copy).toMatch(/ne sont pas couverts/i);
    expect(LANDING_CHAT_INTRO).toMatch(/pièces jointes ne le sont pas/i);

    expect(LANDING_SECURITY_ITEMS[1]?.copy).toMatch(/noms des personnes affectées/i);
    expect(LANDING_SECURITY_ITEMS[1]?.copy).not.toMatch(/se limitent au calendrier/i);

    expect(LANDING_FEATURES[3]?.copy).toMatch(/WhatsApp/i);
    expect(LANDING_FEATURES[3]?.copy).toMatch(/désactivés/i);
    expect(LANDING_FAQ_ITEMS[4]?.a).toMatch(/désactivés/i);

    expect(RETAINED_PUBLIC_CLAIMS.every((claim) => claim.proof.trim().length > 0)).toBe(true);
    expect(RETAINED_PUBLIC_CLAIMS.every((claim) => claim.reviewOwner.trim().length > 0)).toBe(true);
    expect(RETAINED_PUBLIC_CLAIMS.map((claim) => claim.id)).toEqual(
      expect.arrayContaining([
        'chat-text-aes-gcm',
        'share-token-sha256',
        'share-dto-current',
        'csv-formula-injection',
      ]),
    );
  });

  it('empêche de réintroduire un chiffrement au repos non borné dans la landing', () => {
    const landing = readSurface('app/components/landing/LandingPage.tsx');
    expect(landing).not.toMatch(/le tout chiffré au repos/i);
    expect(landing).toContain('LANDING_SECURITY_ITEMS');
    expect(landing).toContain('LANDING_FOOTER_NOTE');
  });
});
