/** @vitest-environment jsdom */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_APP_SETTINGS, markThemeUserOverride } from '@/lib/settings';

const setTheme = vi.fn();
const navigation = { pathname: '/mon-planning' };
const settingsState = { settings: { ...DEFAULT_APP_SETTINGS, themeMode: 'dark' as const } };

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));
vi.mock('next-themes', () => ({
  useTheme: () => ({ setTheme }),
}));
vi.mock('@/hooks/useAppSettings', () => ({
  useAppSettings: () => settingsState,
}));

import { AppThemeSync } from './app-theme-sync';

describe('AppThemeSync', () => {
  beforeEach(() => {
    localStorage.clear();
    setTheme.mockClear();
    navigation.pathname = '/mon-planning';
    settingsState.settings = { ...DEFAULT_APP_SETTINGS, themeMode: 'dark' };
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('applique le thème du club quand l’utilisateur n’a pas choisi', () => {
    render(<AppThemeSync />);
    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('n’écrase pas un thème choisi manuellement (menu mobile Mode clair)', () => {
    markThemeUserOverride();
    render(<AppThemeSync />);
    expect(setTheme).not.toHaveBeenCalled();
  });
});
