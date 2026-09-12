import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { EventsPanel } from './EventsPanel';
import type { AlertItem } from '@/hooks/useDashboardData';
import type { Match } from '@/types/match';

vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ user: { accessRole: 'admin' } }),
}));

vi.mock('./EventCardDrag', () => ({
  EventCardDrag: ({ alert }: { alert?: AlertItem }) => (
    <div>{alert ? `${alert.declined} refus` : 'ok'}</div>
  ),
}));

vi.mock('@/components/ui/add-event-dialog', () => ({
  AddEventDialog: () => null,
}));

vi.mock('./EventTemplatesDialog', () => ({
  EventTemplatesDialog: () => null,
}));

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const match: Match = {
  id: '1',
  date: '2026-09-12',
  time: '07:30',
  localTeam: 'Equipe A',
  awayTeam: 'Equipe B',
  competition: 'Championnat',
  venue: 'domicile',
  type: 'officiel',
  horaireRendezVous: '07:00',
};

const alert: AlertItem = {
  eventType: 'officiel',
  eventId: '1',
  title: 'Match test',
  localTeam: 'Equipe A',
  awayTeam: 'Equipe B',
  date: '12/09/2026',
  time: '07:30',
  missingRoles: ['encadrant'],
  replacementRoles: [],
  pending: 0,
  declined: 1,
  remindersDue: 0,
  planningStatus: 'published',
};

describe('EventsPanel — signaux de contrôle', () => {
  it('affiche le nombre d’événements à traiter dans Événements', () => {
    const html = renderToStaticMarkup(
      <EventsPanel
        events={{ '2026-09-12': [match] }}
        onEventUpdate={() => undefined}
        alerts={{ 'officiel:1': alert }}
      />,
    );

    expect(html).toContain('Événements');
    expect(html).toContain('1 événement à traiter avant publication.');
    expect(html).toContain('Afficher uniquement à traiter');
    expect(html).toContain('1 refus');
    expect(html).not.toContain('Contrôle du planning');
  });

  it('ne compte que les alertes des événements actuellement listés', () => {
    const html = renderToStaticMarkup(
      <EventsPanel
        events={{ '2026-09-12': [match] }}
        onEventUpdate={() => undefined}
        alerts={{
          'officiel:1': alert,
          'officiel:hidden': { ...alert, eventId: 'hidden' },
        }}
      />,
    );

    expect(html).toContain('1 événement à traiter avant publication.');
  });

  it('indique que tout est à jour quand il n’y a pas d’alerte', () => {
    const html = renderToStaticMarkup(
      <EventsPanel
        events={{ '2026-09-12': [match] }}
        onEventUpdate={() => undefined}
        alerts={{}}
      />,
    );

    expect(html).toContain('Tous les postes sont pourvus et les réponses sont à jour.');
    expect(html).not.toContain('à traiter avant publication');
  });
});
