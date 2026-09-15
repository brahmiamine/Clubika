import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  CGU_SECTIONS,
  LEGAL_BASIS_BLOCKER,
  LEGAL_IDENTITY_INCOMPLETE,
  LEGAL_PUBLIC_PATHS,
  PROCESSING_INVENTORY,
  ROLE_QUALIFICATION_BLOCKER,
  isLegalPublicPath,
  readLegalPublisherIdentity,
} from './legal-notice';

const PLACEHOLDER = /\[(nom|name|todo|tbd|xxx|à remplir|votre société)\]|lorem ipsum|acme corp/i;

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('legal notices (issue #12)', () => {
  it('expose les trois routes publiques', () => {
    expect([...LEGAL_PUBLIC_PATHS]).toEqual(['/mentions-legales', '/confidentialite', '/cgu']);
    expect(isLegalPublicPath('/confidentialite')).toBe(true);
    expect(isLegalPublicPath('/club')).toBe(false);
  });

  it('n’invente pas d’éditeur quand les variables manquent', () => {
    const identity = readLegalPublisherIdentity({});
    expect(identity.complete).toBe(false);
    expect(identity.name).toBeNull();
    expect(LEGAL_IDENTITY_INCOMPLETE).toMatch(/LEGAL_PUBLISHER_NAME/);
  });

  it('ne publie le bloc éditeur que si nom, adresse et e-mail sont posés', () => {
    expect(readLegalPublisherIdentity({
      LEGAL_PUBLISHER_NAME: 'Exemple SAS',
      LEGAL_PUBLISHER_ADDRESS: '1 rue Example, 75000 Paris',
      LEGAL_PUBLISHER_EMAIL: 'contact@example.com',
    }).complete).toBe(true);
    expect(readLegalPublisherIdentity({
      LEGAL_PUBLISHER_NAME: 'Exemple SAS',
    }).complete).toBe(false);
  });

  it('refuse de qualifier une base juridique ou un rôle RGPD', () => {
    expect(LEGAL_BASIS_BLOCKER).toMatch(/non qualifiée/i);
    expect(ROLE_QUALIFICATION_BLOCKER).toMatch(/non tranchée/i);
    expect(PROCESSING_INVENTORY.every((item) => item.legalBasisStatus === 'unqualified')).toBe(true);
    expect(CGU_SECTIONS.some((section) => /consentement universel/i.test(section.body))).toBe(true);
  });

  it('n’insère aucun placeholder générique dans les textes et pages', () => {
    const files = [
      'app/lib/compliance/legal-notice.ts',
      'app/mentions-legales/page.tsx',
      'app/confidentialite/page.tsx',
      'app/cgu/page.tsx',
      'docs/governance/README.md',
      'docs/governance/registre-traitements.md',
      'docs/governance/roles-responsabilites.md',
      'docs/governance/article-28.md',
      'docs/governance/aipd.md',
      'docs/governance/violations.md',
    ];
    for (const file of files) {
      expect(read(file), file).not.toMatch(PLACEHOLDER);
    }
  });

  it('cartographie les traitements réellement implémentés', () => {
    const ids = PROCESSING_INVENTORY.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      'accounts',
      'non-account',
      'planning',
      'chat',
      'notifications',
      'public-share',
      'privacy-requests',
      'audit',
      'backups',
      'telemetry-optional',
    ]));
  });
});
