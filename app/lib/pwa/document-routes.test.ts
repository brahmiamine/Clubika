import { describe, expect, it } from 'vitest';
import { usesAppProductDocumentHead, usesTokenClubDocumentHead } from './document-routes';

describe('usesAppProductDocumentHead', () => {
  it('identifie la landing et les écrans hors club', () => {
    expect(usesAppProductDocumentHead('/')).toBe(true);
    expect(usesAppProductDocumentHead('/login')).toBe(true);
    expect(usesAppProductDocumentHead('/plateforme/login')).toBe(true);
    expect(usesAppProductDocumentHead('/mot-de-passe-oublie')).toBe(true);
    expect(usesAppProductDocumentHead('/inscription/xyz')).toBe(true);
    expect(usesAppProductDocumentHead('/mentions-legales')).toBe(true);
    expect(usesAppProductDocumentHead('/confidentialite')).toBe(true);
    expect(usesAppProductDocumentHead('/cgu')).toBe(true);
    expect(usesAppProductDocumentHead('/club')).toBe(false);
    expect(usesAppProductDocumentHead('/partage/abc')).toBe(false);
  });
});

describe('usesTokenClubDocumentHead', () => {
  it('identifie le planning public, pas l’inscription', () => {
    expect(usesTokenClubDocumentHead('/partage/abc')).toBe(true);
    expect(usesTokenClubDocumentHead('/inscription/xyz')).toBe(false);
    expect(usesTokenClubDocumentHead('/')).toBe(false);
  });
});
