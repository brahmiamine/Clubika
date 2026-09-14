'use client';

import { useMemo, memo, useState } from 'react';
import { Match, Entrainement, Plateau } from '@/types/match';
import { EventCardDrag } from './EventCardDrag';
import { AddEventDialog, EventType } from '@/components/ui/add-event-dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Plus, Calendar, LayoutTemplate } from 'lucide-react';
import { EventTemplatesDialog } from './EventTemplatesDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { sortDates, formatDateWithDayName } from '@/lib/utils/date';
import { cn } from '@/lib/utils';
import { MatchExtras } from '@/hooks/useMatchExtras';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { canEdit } from '@/lib/auth/roles';
import { planningEventTypeFromEvent } from '@/lib/planning/event-links';
import type { AlertItem } from '@/hooks/useDashboardData';

type Event = Match | Entrainement | Plateau;

function eventAlert(event: Event, alerts?: Record<string, AlertItem>): AlertItem | undefined {
  if (!alerts || !event.id) return undefined;
  const eventType = planningEventTypeFromEvent(event);
  return alerts[`${eventType}:${event.id}`]
    ?? alerts[`amical:${event.id}`]
    ?? alerts[`officiel:${event.id}`];
}

function eventBlockers(event: Event, blockers?: Record<string, string[]>): string[] | undefined {
  if (!blockers || !event.id) return undefined;
  const eventType = planningEventTypeFromEvent(event);
  return blockers[`${eventType}:${event.id}`]
    ?? blockers[`amical:${event.id}`]
    ?? blockers[`officiel:${event.id}`];
}

interface EventsPanelProps {
  events: Record<string, Event[]>;
  allExtras?: Record<string, MatchExtras>;
  onEventUpdate: () => void | Promise<void>;
  className?: string;
  /** Signaux opérationnels par événement (`eventType:eventId` → alerte). */
  alerts?: Record<string, AlertItem>;
  /** Points bloquants de publication par événement (`eventType:eventId` → messages). */
  publicationBlockers?: Record<string, string[]>;
  onRemind?: (item: AlertItem) => void;
  actionBusy?: boolean;
}

export const EventsPanel = memo(function EventsPanel({
  events,
  allExtras,
  onEventUpdate,
  className,
  alerts,
  publicationBlockers,
  onRemind,
  actionBusy,
}: EventsPanelProps) {
  const { user } = useCurrentUser();
  const editable = canEdit(user?.accessRole);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addDialogType, setAddDialogType] = useState<EventType>('amical');
  const [templatesDialogOpen, setTemplatesDialogOpen] = useState(false);
  const [attentionOnly, setAttentionOnly] = useState(false);

  const sortedDates = useMemo(() => sortDates(Object.keys(events)), [events]);
  const attentionCount = useMemo(
    () => sortedDates.reduce(
      (count, date) => count + (events[date] ?? []).filter((event) => Boolean(eventAlert(event, alerts))).length,
      0,
    ),
    [sortedDates, events, alerts],
  );
  const groupedEvents = useMemo(() => (
    sortedDates
      .map((date) => {
        const dateEvents = events[date] ?? [];
        const visible = attentionOnly
          ? dateEvents.filter((event) => Boolean(eventAlert(event, alerts)))
          : dateEvents;
        return { date, dateEvents: visible };
      })
      .filter((group) => group.dateEvents.length > 0)
  ), [sortedDates, events, attentionOnly, alerts]);

  const handleAddClick = (type: EventType) => {
    setAddDialogType(type);
    setAddDialogOpen(true);
  };

  const handleAddSuccess = () => {
    setAddDialogOpen(false);
    void onEventUpdate();
  };

  return (
    <div className={cn('min-w-0', className)}>
      <Card className="flex h-full min-w-0 flex-col overflow-hidden">
        <div className="p-4 border-b space-y-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex shrink-0 items-center gap-2 text-lg font-semibold">
              <Calendar className="h-5 w-5 shrink-0" />
              Événements
            </h2>
            {editable && (
              <div className="flex shrink-0 items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 min-h-11 w-[8.25rem] justify-center gap-1.5 border px-3"
                  onClick={() => setTemplatesDialogOpen(true)}
                >
                  <LayoutTemplate className="h-4 w-4" />
                  Modèles
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" className="h-11 min-h-11 w-[8.25rem] justify-center gap-1.5 border border-transparent px-3">
                      <Plus className="h-4 w-4" />
                      Ajouter
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => handleAddClick('officiel')}>
                      Match officiel
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleAddClick('amical')}>
                      Match amical
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleAddClick('entrainement')}>
                      Entraînement
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleAddClick('plateau')}>
                      Plateau
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Ouvrez un événement pour affecter les officiels depuis les listes de chaque poste.
          </p>
          {attentionCount > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-destructive">
                {attentionCount} événement{attentionCount > 1 ? 's' : ''} à traiter avant publication.
              </p>
              <Button
                size="sm"
                variant={attentionOnly ? 'secondary' : 'outline'}
                className="h-7"
                onClick={() => setAttentionOnly((current) => !current)}
              >
                {attentionOnly ? 'Voir tous les événements' : 'Afficher uniquement à traiter'}
              </Button>
            </div>
          ) : sortedDates.length > 0 ? (
            <p className="text-sm text-muted-foreground">
              Tous les postes sont pourvus et les réponses sont à jour.
            </p>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {sortedDates.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">Aucun événement</p>
              <p className="text-sm text-muted-foreground mt-2">
                Cliquez sur &quot;Ajouter&quot; pour créer un événement
              </p>
            </div>
          ) : groupedEvents.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">Aucun événement à traiter</p>
              <p className="text-sm text-muted-foreground mt-2">
                Tous les postes sont pourvus et les réponses sont à jour.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {groupedEvents.map(({ date, dateEvents }) => (
                  <div key={date} className="space-y-3">
                    <div className="sticky top-0 z-10 bg-primary text-primary-foreground px-4 py-2 rounded-lg shadow-md">
                      <h3 className="font-bold text-base">
                        {formatDateWithDayName(date)}
                      </h3>
                      <p className="text-xs opacity-90">
                        {dateEvents.length} événement{dateEvents.length > 1 ? 's' : ''}
                      </p>
                    </div>
                    <div className="grid grid-cols-1 gap-2 items-start lg:grid-cols-2">
                      {dateEvents.map((event, index) => {
                        const alert = eventAlert(event, alerts);
                        const blockers = eventBlockers(event, publicationBlockers);
                        return (
                          <div key={event.id ?? `${date}-${index}`} className="min-w-0">
                            <EventCardDrag
                              event={event}
                              allEvents={events}
                              allExtras={allExtras}
                              onEventUpdate={onEventUpdate}
                              onDelete={onEventUpdate}
                              alert={alert}
                              publicationBlockers={blockers}
                              onRemind={alert && onRemind ? () => onRemind(alert) : undefined}
                              actionBusy={actionBusy}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <AddEventDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        eventType={addDialogType}
        onSuccess={handleAddSuccess}
      />
      <EventTemplatesDialog
        open={templatesDialogOpen}
        onOpenChange={setTemplatesDialogOpen}
        onCreated={onEventUpdate}
      />
    </div>
  );
});
