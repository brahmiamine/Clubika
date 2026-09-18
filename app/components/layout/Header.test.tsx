import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Header } from './Header';

vi.mock('next/navigation', () => ({
  usePathname: () => '/club',
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));
vi.mock('@/lib/utils/api', () => ({ apiPost: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { email: 'admin@example.com', accessRole: 'admin', planningFunctions: ['encadrant'] },
    reload: vi.fn(),
  }),
}));
vi.mock('@/hooks/useUnreadNotificationsCount', () => ({ useUnreadNotificationsCount: () => ({ unread: 2 }) }));
vi.mock('@/hooks/useUnreadChatCount', () => ({ useUnreadChatCount: () => ({ unread: 4 }) }));
vi.mock('../matches/ScraperButton', () => ({ ScraperButton: () => <span>Actualiser le scraper</span> }));
vi.mock('../ui/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('../ui/export-button', () => ({ ExportButton: () => null }));
vi.mock('../ui/export-pdf-modal', () => ({ ExportPdfModal: () => null }));
vi.mock('../ui/add-event-dialog', () => ({ AddEventDialog: () => null }));

let features: Record<string, boolean>;
vi.mock('@/hooks/useAppSettings', () => ({
  useAppSettings: () => ({
    settings: {
      clubName: 'AFP',
      clubDescription: '',
      clubLogo: '',
      clubAbbreviation: 'AFP',
      features,
    },
  }),
}));

function baseFeatures(overrides: Partial<Record<string, boolean>> = {}) {
  return {
    assignmentValidation: true,
    publicationReadiness: true,
    autoAssignment: true,
    automaticReminders: true,
    assignmentSwaps: true,
    attendanceTracking: true,
    recurringEvents: true,
    publicSharing: true,
    scraperSync: true,
    officialMatchesCurrentWeekendOnly: true,
    eventChat: true,
    travelAndWeather: true,
    calendarExport: true,
    collaboration: true,
    requireArbitreForPublication: true,
    requireEncadrantForPublication: true,
    requireAccompagnateurForPublication: true,
    massExport: true,
    ...overrides,
  };
}

describe('Header — navigation sensible aux flags (issue #279)', () => {
  it('masque le raccourci « Mes échanges » et le bouton scraper quand leurs flags sont désactivés', () => {
    features = baseFeatures({ assignmentSwaps: false, scraperSync: false });

    const html = renderToStaticMarkup(<Header onScrapeComplete={() => {}} />);

    expect(html).not.toContain('Mes échanges');
    expect(html).not.toContain('Actualiser le scraper');
  });

  it('affiche le raccourci « Mes échanges » et le bouton scraper quand leurs flags sont activés', () => {
    features = baseFeatures();

    const html = renderToStaticMarkup(<Header onScrapeComplete={() => {}} />);

    expect(html).toContain('Mes échanges');
    expect(html).toContain('Actualiser le scraper');
  });
});

describe('Header — badges non lus', () => {
  it('affiche le compteur de messages non lus sur Discussions, comme les notifications', () => {
    features = baseFeatures();

    const html = renderToStaticMarkup(<Header onScrapeComplete={() => {}} />);

    expect(html).toContain('Discussions');
    expect(html).toContain('>4<');
    expect(html).toContain('>2<');
  });
});

describe('Header — thème mobile', () => {
  it('enregistre le choix de thème depuis le menu (sans se faire écraser par le club)', () => {
    const source = readFileSync(new URL('./Header.tsx', import.meta.url), 'utf8');
    expect(source).toContain('applyUserThemeChoice("light"');
    expect(source).toContain('applyUserThemeChoice("dark"');
    expect(source).toContain('applyUserThemeChoice("system"');
    expect(source).toContain('onSelect={() => applyUserThemeChoice');
  });
});
