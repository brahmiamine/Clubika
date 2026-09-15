'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Check, Clock3, History, MapPin, X } from 'lucide-react';
import { Header } from '@/app/components/layout/Header';
import { Badge } from '@/app/components/ui/badge';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { PageHeader, StatusPill } from '@/app/components/layout/page-primitives';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet, apiPost } from '@/lib/utils/api';
import { isInteractiveTarget, personalEventWorkspaceHref } from '@/lib/planning/event-links';
import { eventStartTimestamp } from '@/lib/planning/p0-rules';
import { zonedDayStart } from '@/lib/planning/planning-time';
import { useAppSettings } from '@/hooks/useAppSettings';
import { useNow } from '@/hooks/useNow';
import { TeamMatchup } from '@/app/components/matches/TeamMatchup';
import { EventCardWeather } from '@/app/components/events/EventCardWeather';
import type { EventWeatherDisplay } from '@/lib/planning/weather-condition';
import { toast } from 'sonner';

type AssignmentStatus = 'pending' | 'accepted' | 'declined';
type EventType = 'officiel' | 'amical' | 'entrainement' | 'plateau';
type PlanningRole = 'arbitre' | 'encadrant' | 'accompagnateur';
type DeclineReason = 'work' | 'travel' | 'other_assignment' | 'personal' | 'other';

/** Une fonction tenue par l'utilisateur sur un événement, avec son statut et sa réponse
 *  propres (issue #281) — un dirigeant multi-fonctions a une entrée par fonction, chacune
 *  indépendamment acceptable/refusable. */
interface PersonalPlanningFunction {
  assignmentId: string;
  role: PlanningRole;
  status: AssignmentStatus;
  respondedAt: string | null;
  declineReason?: DeclineReason | null;
  declineComment?: string | null;
}

/** Une carte « Mon planning » par événement : `functions` porte la ou les fonctions
 *  tenues par l'utilisateur sur cet événement (issue #281). */
interface PersonalPlanningEvent {
  eventKey: string;
  eventId: string;
  eventType: EventType;
  date: string;
  time: string;
  durationMinutes: number;
  title: string;
  localTeam?: string;
  awayTeam?: string;
  localTeamLogo?: string;
  awayTeamLogo?: string;
  categorie: string | null;
  lieu: string | null;
  adresse: string | null;
  itineraryLink: string | null;
  rendezVous: string | null;
  seriesId: string | null;
  confirmed: boolean | null;
  cancelled: boolean;
  functions: PersonalPlanningFunction[];
  weather?: EventWeatherDisplay | null;
}

interface PlanningStats {
  totalEvents: number;
  totalAssignments: number;
  upcomingEvents: number;
  pastEvents: number;
  pending: number;
  accepted: number;
  declined: number;
  officiel: number;
  amical: number;
  entrainement: number;
  plateau: number;
}

interface PlanningResponse {
  events: PersonalPlanningEvent[];
  stats: PlanningStats;
}

const declineLabels: Record<DeclineReason, string> = {
  work: 'Travail',
  travel: 'Voyage / déplacement',
  other_assignment: 'Autre affectation',
  personal: 'Contrainte personnelle',
  other: 'Autre',
};

/**
 * Utilise le fuseau horaire du club, comme les règles serveur (`eventStartTimestamp`) :
 * reconstruire la date dans le fuseau du navigateur ferait apparaître/disparaître les
 * actions Accepter/Refuser à un instant différent de celui appliqué par l'API pour un
 * utilisateur connecté depuis un autre fuseau (issue #90).
 */
function eventTimestamp(item: PersonalPlanningEvent, timeZone: string): number {
  return eventStartTimestamp(item.date, item.time, timeZone) ?? 0;
}

function statusBadge(status: AssignmentStatus) {
  if (status === 'accepted') return <StatusPill tone="success">Acceptée</StatusPill>;
  if (status === 'declined') return <StatusPill tone="danger">Refusée</StatusPill>;
  return <StatusPill tone="pending">En attente</StatusPill>;
}

function typeLabel(type: EventType): string {
  if (type === 'officiel') return 'Match officiel';
  if (type === 'amical') return 'Match amical';
  if (type === 'entrainement') return 'Entraînement';
  return 'Plateau';
}

function roleLabel(role: PlanningRole): string {
  if (role === 'arbitre') return 'Arbitre club';
  if (role === 'accompagnateur') return 'Accompagnateur';
  return 'Encadrant';
}

export default function MonPlanningPage() {
  const router = useRouter();
  const { settings } = useAppSettings();
  const timeZone = settings.timeZone;
  const nowMs = useNow();
  const [data, setData] = useState<PlanningResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [responding, setResponding] = useState<string | null>(null);
  const [declines, setDeclines] = useState<Record<string, DeclineReason>>({});
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await apiGet<PlanningResponse>('/api/me/planning'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de charger votre planning');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const { upcoming, history } = useMemo(() => {
    // Bascule à la journée près (fuseau du club) : un événement du jour reste dans
    // « Prochaines affectations » jusqu'à la fin de la journée et ne passe dans
    // « Historique » qu'à partir du lendemain, même s'il est déjà terminé.
    const startOfToday = zonedDayStart(nowMs, timeZone);
    const dayStart = (item: PersonalPlanningEvent) => eventStartTimestamp(item.date, '00:00', timeZone) ?? 0;
    const all = data?.events ?? [];
    return {
      upcoming: all.filter((item) => dayStart(item) >= startOfToday),
      history: all.filter((item) => dayStart(item) < startOfToday).reverse(),
    };
  }, [data, timeZone, nowMs]);

  const respond = async (event: PersonalPlanningEvent, fn: PersonalPlanningFunction, status: 'accepted' | 'declined') => {
    setResponding(fn.assignmentId);
    const declineReason = declines[fn.assignmentId] ?? 'personal';
    try {
      await apiPost('/api/me/assignments/respond', {
        eventId: event.eventId,
        eventType: event.eventType,
        role: fn.role,
        status,
        declineReason: status === 'declined' ? declineReason : undefined,
      });
      toast.success(status === 'accepted' ? 'Affectation acceptée' : 'Affectation refusée');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible d’enregistrer votre réponse');
    } finally {
      setResponding(null);
    }
  };

  // Une fonction à la fois : chaque fonction tenue sur l'événement (issue #281) conserve
  // son propre statut et sa propre action Accepter/Refuser, indépendamment des autres
  // fonctions du dirigeant sur ce même événement.
  const renderFunction = (event: PersonalPlanningEvent, fn: PersonalPlanningFunction, started: boolean) => {
    const declineReason = declines[fn.assignmentId] ?? 'personal';
    return (
      <div key={fn.assignmentId} className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{roleLabel(fn.role)}</Badge>
          {event.cancelled ? <Badge variant="destructive">Annulé</Badge> : statusBadge(fn.status)}
        </div>
        {!event.cancelled && fn.status === 'declined' && fn.declineReason && (
          <p className="text-xs text-destructive">
            Motif : {declineLabels[fn.declineReason] ?? 'Indisponible'}
          </p>
        )}
        {!event.cancelled && !started && fn.status === 'pending' && (
          <>
            <select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={declineReason} onChange={(changeEvent) => setDeclines((current) => ({ ...current, [fn.assignmentId]: changeEvent.target.value as DeclineReason }))}>
              {Object.entries(declineLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => respond(event, fn, 'accepted')} disabled={responding === fn.assignmentId}><Check className="mr-1.5 h-4 w-4" /> Accepter</Button>
              <Button variant="destructive" size="sm" onClick={() => respond(event, fn, 'declined')} disabled={responding === fn.assignmentId}><X className="mr-1.5 h-4 w-4" /> Refuser</Button>
            </div>
          </>
        )}
      </div>
    );
  };

  const renderEvent = (event: PersonalPlanningEvent) => {
    // Issue #43 : dès le coup d'envoi, la confirmation est figée — on masque les actions
    // Accepter/Refuser et on bascule vers la présence / le rapport post-événement. Le
    // serveur applique la même règle avec le fuseau horaire du club.
    const startTs = eventTimestamp(event, timeZone);
    const started = startTs > 0 && startTs <= nowMs;
    const openWorkspace = () => router.push(personalEventWorkspaceHref(event.eventType, event.eventId));
    const venueLabel = [event.lieu, event.adresse].filter(Boolean).join(' · ');
    const mapsHref = event.itineraryLink
      || (venueLabel ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venueLabel)}` : null);
    return (
      <Card
        key={event.eventKey}
        role="link"
        tabIndex={0}
        aria-label="Ouvrir le détail de l’affectation"
        onClick={(clickEvent) => { if (!isInteractiveTarget(clickEvent.target)) openWorkspace(); }}
        onKeyDown={(keyEvent) => { if (keyEvent.key === 'Enter' && keyEvent.target === keyEvent.currentTarget) openWorkspace(); }}
        className="cursor-pointer gap-3 py-4 transition-colors hover:border-primary/40 hover:bg-secondary-soft"
      >
        <CardHeader className="gap-1.5 px-4 pb-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Badge variant="brand">{typeLabel(event.eventType)}</Badge>
              {event.cancelled && <Badge variant="destructive">Annulé</Badge>}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <p className="text-sm font-medium tabular-nums">{event.date} · {event.time}</p>
              <EventCardWeather weather={event.weather} variant="inline" />
            </div>
          </div>
          <CardTitle className="text-sm leading-snug sm:text-base">
            <TeamMatchup
              localTeam={event.localTeam}
              awayTeam={event.awayTeam}
              localTeamLogo={event.localTeamLogo}
              awayTeamLogo={event.awayTeamLogo}
              logoSize={18}
              fallbackTitle={event.title}
              nameClassName="text-sm"
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 text-sm">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
            {event.categorie && <span>{event.categorie}</span>}
            {event.rendezVous && (
              <span className="inline-flex items-center gap-1">
                <Clock3 className="h-3.5 w-3.5" />
                RDV {event.rendezVous}
              </span>
            )}
          </p>
          {venueLabel && (
            mapsHref ? (
              <a
                href={mapsHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-start gap-1.5 text-primary underline-offset-2 hover:underline"
              >
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{venueLabel}</span>
              </a>
            ) : (
              <p className="inline-flex items-start gap-1.5 text-muted-foreground">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{venueLabel}</span>
              </p>
            )
          )}
          {event.cancelled && (
            <p className="text-xs text-destructive">Événement annulé — aucune action possible.</p>
          )}
          {!event.cancelled && started && (
            <p className="text-xs text-muted-foreground">Réponses closes — présence depuis le détail.</p>
          )}
          {event.functions.map((fn) => renderFunction(event, fn, started))}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="min-h-screen bg-background">
      <Header onScrapeComplete={() => undefined} />
      <main className="container mx-auto max-w-6xl px-3 py-5 sm:px-4 sm:py-8">
        <PageHeader
          className="mb-5"
          icon={<CalendarDays />}
          title="Mon planning"
          description={
            data
              ? data.stats.pending > 0
                ? `${data.stats.pending} réponse${data.stats.pending > 1 ? 's' : ''} en attente`
                : upcoming.length > 0
                  ? `${upcoming.length} affectation${upcoming.length > 1 ? 's' : ''} à venir`
                  : 'Aucune affectation à venir.'
              : 'Vos prochaines affectations.'
          }
        />

        {loading ? <LoadingSpinner size={44} text="Chargement de votre planning..." className="py-20" /> : !data ? null : (
          <>
            <section>
              <h2 className="mb-3 text-base font-semibold">Prochaines affectations</h2>
              {upcoming.length ? (
                <div className="grid gap-3">{upcoming.map(renderEvent)}</div>
              ) : (
                <Card>
                  <CardContent className="py-8 text-center text-sm text-muted-foreground">
                    Aucune affectation à venir.
                  </CardContent>
                </Card>
              )}
            </section>

            {history.length > 0 && (
              <section className="mt-8">
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm font-medium"
                  onClick={() => setShowHistory((open) => !open)}
                  aria-expanded={showHistory}
                >
                  <span className="flex items-center gap-2">
                    <History className="h-4 w-4 text-muted-foreground" />
                    Historique
                    <span className="text-muted-foreground">({history.length})</span>
                  </span>
                  <span className="text-muted-foreground">{showHistory ? 'Masquer' : 'Afficher'}</span>
                </button>
                {showHistory && <div className="mt-3 grid gap-3">{history.map(renderEvent)}</div>}
              </section>
            )}

            <nav className="mt-8 flex flex-wrap gap-x-4 gap-y-2 text-sm text-muted-foreground" aria-label="Raccourcis planning">
              <Link href="/mon-planning/mon-calendrier" className="hover:text-foreground hover:underline">
                Ajouter à mon calendrier
              </Link>
            </nav>
          </>
        )}
      </main>
    </div>
  );
}
