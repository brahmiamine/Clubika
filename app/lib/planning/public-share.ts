import { createHash, randomBytes } from 'node:crypto';
import type { Match } from '@/types/match';
import type { PlanningEventSnapshot, PlanningEventType } from './event-store';
import type { TeamLogoResolver } from './team-logos';

/**
 * DTO public (issue #6) : liste blanche calendrier uniquement.
 * Pas de noms de personnes, téléphones, e-mails, identifiants internes,
 * convocation, commentaires, rapports ni audit.
 */
export interface PublicPlanningItem {
  eventType: PlanningEventType;
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
  } | null;
}

export const PUBLIC_PLANNING_ITEM_KEYS = [
  'eventType',
  'title',
  'date',
  'time',
  'endTime',
  'durationMinutes',
  'category',
  'competition',
  'homeTeam',
  'awayTeam',
  'homeTeamLogo',
  'awayTeamLogo',
  'venue',
  'stadium',
  'address',
  'weather',
] as const;

export const FORBIDDEN_PUBLIC_PLANNING_KEYS = [
  'officials',
  'referee',
  'assistants',
  'meetingTime',
  'location',
  'personId',
  'personType',
  'numero',
  'email',
  'telephone',
  'assignments',
  'clubId',
  'comments',
  'rapport',
  'audit',
] as const;

const EVENT_TYPE_TITLES: Record<PlanningEventType, string> = {
  officiel: 'Match officiel',
  amical: 'Match amical',
  entrainement: 'Entraînement',
  plateau: 'Plateau',
};

const PUBLIC_VENUE_HINT = /stade|gymnase|complexe|terrain|sport|municipal|omnisport|hall des sports/i;

export interface PublicShareScope {
  eventTypes: PlanningEventType[];
  fromDate: string | null;
  toDate: string | null;
}

export function newShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function eventCategory(snapshot: PlanningEventSnapshot): string | null {
  if (snapshot.eventType === 'officiel' || snapshot.eventType === 'amical') {
    return 'categorie' in snapshot.event && typeof snapshot.event.categorie === 'string'
      ? snapshot.event.categorie
      : null;
  }
  if (snapshot.eventType === 'entrainement') {
    return 'categorie' in snapshot.event && typeof snapshot.event.categorie === 'string'
      ? snapshot.event.categorie
      : null;
  }
  return 'categories' in snapshot.event && Array.isArray(snapshot.event.categories)
    ? snapshot.event.categories.join(', ')
    : null;
}

/** Heure de fin « HH:MM » à partir d'une heure de début « HH:MM » et d'une durée en minutes. */
export function endTimeFromStart(time: string, durationMinutes: number): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const start = Number.parseInt(match[1] ?? '', 10) * 60 + Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(start) || !Number.isFinite(durationMinutes)) return null;
  const end = ((start + Math.max(0, Math.round(durationMinutes))) % (24 * 60) + 24 * 60) % (24 * 60);
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}

function isMatchEvent(snapshot: PlanningEventSnapshot): snapshot is PlanningEventSnapshot & { event: Match } {
  return snapshot.eventType === 'officiel' || snapshot.eventType === 'amical';
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function publicCalendarTitle(item: Pick<PublicPlanningItem, 'eventType' | 'category' | 'homeTeam' | 'awayTeam'>): string {
  if (item.homeTeam && item.awayTeam) return `${item.homeTeam} – ${item.awayTeam}`;
  if (item.category) return `${EVENT_TYPE_TITLES[item.eventType]} · ${item.category}`;
  return EVENT_TYPE_TITLES[item.eventType];
}

/** Adresse uniquement pour une enceinte sportive officielle, jamais un lieu libre. */
export function publicSportsVenueAddress(stadium: string | null, address: string | null): string | null {
  if (!stadium || !address) return null;
  if (!PUBLIC_VENUE_HINT.test(stadium) && !PUBLIC_VENUE_HINT.test(address)) return null;
  return address;
}

export function toPublicPlanningItem(
  snapshot: PlanningEventSnapshot,
  resolveLogos?: TeamLogoResolver,
): PublicPlanningItem {
  const category = eventCategory(snapshot);
  const item: PublicPlanningItem = {
    eventType: snapshot.eventType,
    title: publicCalendarTitle({ eventType: snapshot.eventType, category, homeTeam: null, awayTeam: null }),
    date: snapshot.date,
    time: snapshot.time,
    endTime: endTimeFromStart(snapshot.time, snapshot.durationMinutes),
    durationMinutes: snapshot.durationMinutes,
    category,
    competition: null,
    homeTeam: null,
    awayTeam: null,
    homeTeamLogo: null,
    awayTeamLogo: null,
    venue: null,
    stadium: null,
    address: null,
  };

  if (isMatchEvent(snapshot)) {
    const match = snapshot.event;
    const logos = resolveLogos?.(match) ?? {};
    item.competition = cleanString(match.competition) ?? cleanString(match.details?.competition);
    item.homeTeam = cleanString(match.localTeam);
    item.awayTeam = cleanString(match.awayTeam);
    item.homeTeamLogo = cleanString(logos.localTeamLogo);
    item.awayTeamLogo = cleanString(logos.awayTeamLogo);
    item.venue = match.venue === 'domicile' || match.venue === 'extérieur' ? match.venue : null;
    item.stadium = cleanString(match.details?.stadium);
    item.address = publicSportsVenueAddress(item.stadium, cleanString(match.details?.address));
    item.title = publicCalendarTitle(item);
  }

  return item;
}

export function isSnapshotInShareScope(snapshot: PlanningEventSnapshot, scope: PublicShareScope): boolean {
  if (scope.eventTypes.length && !scope.eventTypes.includes(snapshot.eventType)) return false;
  const [day, month, year] = snapshot.date.split('/').map((part) => Number.parseInt(part, 10));
  if (!day || !month || !year) return false;
  const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (scope.fromDate && isoDate < scope.fromDate) return false;
  if (scope.toDate && isoDate > scope.toDate) return false;
  return true;
}
