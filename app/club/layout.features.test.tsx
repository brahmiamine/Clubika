import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ClubLayout from './ClubLayoutClient';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/utils/api', () => ({ apiPost: vi.fn() }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { email: 'admin@example.com' }, reload: vi.fn() }),
}));
vi.mock('@/hooks/useUnreadNotificationsCount', () => ({ useUnreadNotificationsCount: () => ({ unread: 0 }) }));
vi.mock('@/hooks/useUnreadChatCount', () => ({ useUnreadChatCount: () => ({ unread: 0 }) }));
vi.mock('@/hooks/useAppSettings', () => ({
  useAppSettings: () => ({
    settings: {
      clubName: 'AFP',
      clubDescription: '',
      clubLogo: '',
      clubAbbreviation: 'AFP',
      features: {
        assignmentValidation: true,
        publicationReadiness: true,
        autoAssignment: true,
        automaticReminders: true,
        assignmentSwaps: false,
        attendanceTracking: true,
        recurringEvents: false,
        publicSharing: false,
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
      },
    },
  }),
}));
vi.mock('@/app/components/layout/DashboardShell', () => ({
  DashboardShell: ({ sections, children }: {
    sections: Array<{ items: Array<{ href: string; label: string }> }>;
    children: React.ReactNode;
  }) => (
    <div>
      {sections.flatMap((section) => section.items).map((item) => <span key={item.href}>{item.label}</span>)}
      {children}
    </div>
  ),
}));

describe('ClubLayout feature navigation (issue #149)', () => {
  it('masque les pages dont le flag est désactivé', () => {
    const html = renderToStaticMarkup(<ClubLayout><div>page</div></ClubLayout>);

    expect(html).not.toContain('Échanges');
    expect(html).not.toContain('Planning récurrent');
    expect(html).not.toContain('Partage public');
    expect(html).toContain('Préparation du planning');
    expect(html).toContain('Indisponibilités');
    expect(html).toContain('Archives');
  });
});
