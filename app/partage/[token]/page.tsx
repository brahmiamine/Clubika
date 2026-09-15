'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { CalendarDays, Clock, MapPin, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { TeamLogo } from '@/app/components/ui/team-logo';
import { EventCardWeather } from '@/app/components/events/EventCardWeather';
import { apiGet } from '@/lib/utils/api';
import { parseDateString } from '@/lib/utils/date';
import { applyBrowserTabIdentity } from '@/lib/pwa/document-head';
import {
  applyDefaultThemeVariables,
  applyThemeVariables,
  DEFAULT_APP_SETTINGS,
  hasThemeUserOverride,
  type ThemeMode,
} from '@/lib/settings';

interface PublicItem {
  eventType: 'officiel' | 'amical' | 'entrainement' | 'plateau';
  title: string;
  date: string;
  time: string;
  endTime: string | null;
  durationMinutes: number;
  category: string | null;
  competition: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  homeTeamLogo: string | null;
  awayTeamLogo: string | null;
  venue: 'domicile' | 'extérieur' | null;
  stadium: string | null;
  address: string | null;
  weather?: {
    weatherCode: number;
    temperatureC: number | null;
    isDay?: boolean | null;
  } | null;
}

interface PublicPlanning {
  expiresAt: string;
  generatedAt?: string;
  scope?: { eventTypes: string[]; fromDate: string | null; toDate: string | null };
  club?: {
    name: string | null;
    logo: string | null;
    primaryColor?: string;
    accentColor?: string;
    themeMode?: ThemeMode;
  };
  items: PublicItem[];
}

const EVENT_TYPE_LABELS: Record<PublicItem['eventType'], string> = {
  officiel: 'Match officiel',
  amical: 'Match amical',
  entrainement: 'Entraînement',
  plateau: 'Plateau',
};

function longFrenchDate(ddmmyyyy: string): string {
  const date = parseDateString(ddmmyyyy);
  if (Number.isNaN(date.getTime())) return ddmmyyyy;
  const formatted = date.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function timeRange(item: PublicItem): string {
  if (!item.time) return `${item.durationMinutes} min`;
  return item.endTime ? `${item.time} – ${item.endTime}` : item.time;
}

function MatchHeader({ item }: { item: PublicItem }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-primary/15 bg-secondary/50 p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 items-center gap-2 sm:flex-1">
        <TeamLogo logo={item.homeTeamLogo ?? undefined} name={item.homeTeam ?? ''} size={28} className="h-7 w-7 shrink-0" />
        <span className="min-w-0 break-words font-semibold text-pretty">{item.homeTeam ?? '—'}</span>
      </div>
      <span className="self-center text-xs font-medium text-muted-foreground sm:shrink-0">vs</span>
      <div className="flex min-w-0 items-center gap-2 sm:flex-1 sm:justify-end sm:text-right">
        <span className="min-w-0 break-words font-semibold text-pretty sm:order-1">{item.awayTeam ?? '—'}</span>
        <TeamLogo logo={item.awayTeamLogo ?? undefined} name={item.awayTeam ?? ''} size={28} className="h-7 w-7 shrink-0 sm:order-2" />
      </div>
    </div>
  );
}

function EventCard({ item }: { item: PublicItem }) {
  const isMatch = item.eventType === 'officiel' || item.eventType === 'amical';
  const mapsUrl = item.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.address)}`
    : null;

  return (
    <Card className="gap-4 py-4 break-inside-avoid sm:gap-6 sm:py-6">
      <CardHeader className="space-y-3 px-4 pb-2 sm:px-6 sm:pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
          <CardTitle className="text-base text-pretty">
            {item.title}
          </CardTitle>
          <div className="flex flex-wrap gap-1 sm:shrink-0 sm:justify-end">
            <Badge variant="outline">{EVENT_TYPE_LABELS[item.eventType]}</Badge>
            {isMatch && item.venue && (
              <Badge variant={item.venue === 'domicile' ? 'default' : 'secondary'}>
                {item.venue === 'domicile' ? 'Domicile' : 'Extérieur'}
              </Badge>
            )}
          </div>
        </div>
        {isMatch && <MatchHeader item={item} />}
      </CardHeader>
      <CardContent className="space-y-2.5 px-4 text-sm sm:px-6">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Clock className="h-4 w-4 shrink-0 text-primary" />
          <span>{timeRange(item)}</span>
        </p>
        <EventCardWeather weather={item.weather} variant="inline" className="text-sm" />
        {item.category && (
          <p className="flex items-start gap-2">
            <Users className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 break-words text-pretty">{item.category}</span>
          </p>
        )}
        {item.stadium && (
          <p className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 break-words text-pretty">
              {item.stadium}
              {item.address && (
                <>
                  <br />
                  <span className="text-muted-foreground">
                    {mapsUrl ? (
                      <a href={mapsUrl} target="_blank" rel="noreferrer" className="underline break-words">
                        {item.address}
                      </a>
                    ) : (
                      item.address
                    )}
                  </span>
                </>
              )}
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function PublicPlanningSharePage() {
  const params = useParams<{ token: string }>();
  const { setTheme } = useTheme();
  const [data, setData] = useState<PublicPlanning | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) return;
    apiGet<PublicPlanning>(`/api/public/planning/${encodeURIComponent(params.token)}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : 'Lien indisponible'));
  }, [params.token]);

  useEffect(() => {
    const club = data?.club;
    if (!club?.primaryColor && !club?.accentColor) {
      applyDefaultThemeVariables();
      return;
    }

    applyThemeVariables({
      ...DEFAULT_APP_SETTINGS,
      primaryColor: club.primaryColor || DEFAULT_APP_SETTINGS.primaryColor,
      accentColor: club.accentColor || DEFAULT_APP_SETTINGS.accentColor,
    });
    if (club.themeMode && !hasThemeUserOverride()) {
      setTheme(club.themeMode);
    }

    const clubName = club.name?.trim();
    if (clubName) {
      applyBrowserTabIdentity({
        title: clubName,
        iconHref: club.logo || '/favicon.png',
        themeColor: club.primaryColor,
      });
    }
  }, [data, setTheme]);

  const groups = useMemo(() => {
    if (!data) return [] as { date: string; items: PublicItem[] }[];
    const byDate = new Map<string, PublicItem[]>();
    for (const item of data.items) {
      const list = byDate.get(item.date) ?? [];
      list.push(item);
      byDate.set(item.date, list);
    }
    return [...byDate.entries()].map(([date, items]) => ({ date, items }));
  }, [data]);

  const scopeLabel = useMemo(() => {
    if (!data?.scope) return null;
    const types = data.scope.eventTypes.length
      ? data.scope.eventTypes.map((t) => EVENT_TYPE_LABELS[t as PublicItem['eventType']] ?? t).join(', ')
      : 'Tous les événements';
    const range = data.scope.fromDate || data.scope.toDate
      ? ` · ${data.scope.fromDate ?? '…'} → ${data.scope.toDate ?? '…'}`
      : '';
    return `${types}${range}`;
  }, [data]);

  return (
    <div className="min-h-screen bg-secondary-soft">
      <main className="mx-auto max-w-5xl space-y-5 px-3 py-6 text-foreground sm:space-y-6 sm:px-4 sm:py-8">
      <header className="space-y-3 border-b pb-4 sm:pb-5">
        <div className="flex items-start gap-3 sm:items-center">
          {data?.club?.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.club.logo}
              alt={data.club.name ?? 'Club'}
              className="h-11 w-11 shrink-0 rounded-full border object-cover sm:h-12 sm:w-12"
            />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border bg-muted sm:h-12 sm:w-12">
              <CalendarDays className="h-6 w-6 text-muted-foreground" />
            </span>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-pretty sm:text-2xl">{data?.club?.name || 'Planning partagé'}</h1>
            <p className="text-sm text-muted-foreground text-pretty">Planning partagé · vue publique en lecture seule</p>
          </div>
        </div>
        {data && (
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {scopeLabel && <span>{scopeLabel}</span>}
            {data.generatedAt && <span>Généré le {new Date(data.generatedAt).toLocaleString('fr-FR')}</span>}
            <span>Lien valable jusqu’au {new Date(data.expiresAt).toLocaleString('fr-FR')}</span>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Vue calendrier uniquement : aucune identité, coordonnée ni affectation n’est affichée.
        </p>
      </header>

      {error ? (
        <Card><CardContent className="py-10 text-center text-destructive">{error}</CardContent></Card>
      ) : !data ? (
        <LoadingSpinner size={44} text="Chargement du planning..." className="py-20" />
      ) : !data.items.length ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">Aucun événement dans cette période.</CardContent></Card>
      ) : (
        <div className="space-y-6 sm:space-y-8">
          {groups.map((group) => (
            <section key={group.date} className="space-y-3">
              <h2 className="flex items-start gap-2 text-base font-semibold text-pretty sm:items-center sm:text-lg">
                <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-primary sm:mt-0" />
                {longFrenchDate(group.date)}
              </h2>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {group.items.map((item, index) => (
                  <EventCard key={`${item.eventType}:${item.time}:${index}`} item={item} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      </main>
    </div>
  );
}
