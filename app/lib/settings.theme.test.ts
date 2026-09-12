/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyUserThemeChoice, hasThemeUserOverride, markThemeUserOverride } from './settings';

describe('applyUserThemeChoice', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('marque le choix utilisateur puis applique le thème', () => {
    const setTheme = vi.fn();

    applyUserThemeChoice('light', setTheme);

    expect(hasThemeUserOverride()).toBe(true);
    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('hasThemeUserOverride est faux tant que l’utilisateur n’a pas choisi', () => {
    expect(hasThemeUserOverride()).toBe(false);
    markThemeUserOverride();
    expect(hasThemeUserOverride()).toBe(true);
  });
});
