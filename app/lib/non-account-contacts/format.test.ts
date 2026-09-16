import { describe, expect, it } from 'vitest';
import { hashContactLookup, maskTelephone } from './format';
import { parseContactCsv } from './csv';

describe('maskTelephone', () => {
  it('masque tout sauf les deux derniers chiffres', () => {
    expect(maskTelephone('0600000099')).toBe('•• •• •• •• 99');
    expect(maskTelephone(null)).toBeNull();
  });
});

describe('hashContactLookup', () => {
  it('est déterministe et isolé par club', () => {
    const a = hashContactLookup('club-a', '0600000000');
    const b = hashContactLookup('club-a', '0600000000');
    const c = hashContactLookup('club-b', '0600000000');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseContactCsv', () => {
  it('lit les en-têtes et ignore les lignes vides', () => {
    const rows = parseContactCsv('nom,provenance,category\n\nAda,responsable_club,officiel\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.values.nom).toBe('Ada');
    expect(rows[0]?.line).toBe(3);
  });
});
