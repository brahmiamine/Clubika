import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MobileTabBar } from './MobileTabBar';

let mockPathname = '/club';

vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({
    user: { accessRole: 'admin', planningFunctions: ['encadrant'] },
    isLoading: false,
  }),
}));
vi.mock('@/hooks/useUnreadNotificationsCount', () => ({ useUnreadNotificationsCount: () => ({ unread: 2 }) }));
vi.mock('@/hooks/useUnreadChatCount', () => ({ useUnreadChatCount: () => ({ unread: 5 }) }));

describe('MobileTabBar — badges non lus (issue #343)', () => {
  it('affiche les badges chat et notifications sur les onglets correspondants', () => {
    mockPathname = '/club';
    const html = renderToStaticMarkup(<MobileTabBar />);

    expect(html).toContain('Chat');
    expect(html).toContain('Notifs');
    expect(html).toContain('>5<');
    expect(html).toContain('>2<');
  });
});

describe('MobileTabBar — page d’accueil', () => {
  it('masque la barre sur la landing /', () => {
    mockPathname = '/';
    const html = renderToStaticMarkup(<MobileTabBar />);

    expect(html).toBe('');
  });
});

describe('MobileTabBar — ancrage mobile', () => {
  it('reste dans le flux en bas d’écran au lieu d’être position:fixed', () => {
    mockPathname = '/mon-planning';
    const html = renderToStaticMarkup(<MobileTabBar />);

    expect(html).toContain('aria-label="Navigation principale"');
    expect(html).toContain('shrink-0');
    expect(html).toContain('min-h-[4.5rem]');
    expect(html).not.toContain('fixed inset-x-0 bottom-0');
    expect(html).not.toContain('h-[calc(4.5rem+env(safe-area-inset-bottom))]');
  });
});
