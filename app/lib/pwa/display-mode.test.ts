// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isStandaloneDisplay, PWA_START_URL } from './display-mode';

describe('PWA_START_URL', () => {
  it('ouvre l’espace authentifié, pas la landing', () => {
    expect(PWA_START_URL).toBe('/login');
  });
});

describe('isStandaloneDisplay', () => {
  afterEach(() => {
    delete (navigator as Navigator & { standalone?: boolean }).standalone;
  });

  it('détecte display-mode standalone (Android / Chrome)', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query.includes('standalone'),
        addEventListener() {},
        removeEventListener() {},
      }),
    });
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('détecte navigator.standalone (iOS)', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    (navigator as Navigator & { standalone?: boolean }).standalone = true;
    expect(isStandaloneDisplay()).toBe(true);
  });

  it('reste faux dans un onglet navigateur', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    expect(isStandaloneDisplay()).toBe(false);
  });
});
