import { Match, Entrainement, Plateau, ClubInfo, type AssignmentContact, type PersonType } from '@/types/match';
import { MatchExtras } from '@/hooks/useMatchExtras';
import { getEventDurationMinutes, type AssignmentRole } from './assignment-conflicts';
import { assignmentStatus, eventStartTimestamp, isVisiblePublicationStatus, normalizePlanningStatus } from '@/lib/planning/p0-rules';
import { roleLabelWithClub } from '@/lib/settings';

type Event = Match | Entrainement | Plateau;

function isMatchEvent(event: Event): event is Match {
  return 'localTeam' in event || 'competition' in event;
}

function parseEventDate(date: string, time: string | undefined, timeZone: string): Date | null {
  const timestamp = eventStartTimestamp(date, time || '00:00', timeZone);
  return timestamp === null ? null : new Date(timestamp);
}

function toIcalUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcalText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  let rest = line;
  while (rest.length > 75) {
    chunks.push(rest.slice(0, 75));
    rest = ' ' + rest.slice(75);
  }
  chunks.push(rest);
  return chunks.join('\r\n');
}

function getEventTitle(event: Event): string {
  if (isMatchEvent(event)) return `${event.localTeam} vs ${event.awayTeam}`;
  if (event.type === 'entrainement') return `Entraînement${event.categorie ? ` — ${event.categorie}` : ''}`;
  if (event.type === 'plateau') return `Plateau${event.categories?.length ? ` — ${event.categories.join(', ')}` : ''}`;
  return 'Événement';
}

function getEventLocation(event: Event): string {
  if (isMatchEvent(event)) return event.details?.stadium || '';
  return event.lieu || '';
}

function getEventDescription(event: Event, extras: MatchExtras | undefined, clubAbbreviation = ''): string {
  const lines: string[] = [];
  const arbitreLabel = roleLabelWithClub('Arbitre', clubAbbreviation);
  const encadrantsLabel = roleLabelWithClub('Encadrants', clubAbbreviation);
  const accompagnateursLabel = roleLabelWithClub('Accompagnateurs', clubAbbreviation);
  if (isMatchEvent(event)) {
    if (event.competition) lines.push(`Compétition: ${event.competition}`);
    if (event.details?.address) lines.push(`Adresse: ${event.details.address}`);
    if (extras?.arbitreTouche?.length) lines.push(`${arbitreLabel}: ${extras.arbitreTouche.map((c) => c.nom).join(', ')}`);
    if (extras?.contactEncadrants?.length) lines.push(`${encadrantsLabel}: ${extras.contactEncadrants.map((c) => c.nom).join(', ')}`);
    if (extras?.contactAccompagnateur?.length) lines.push(`${accompagnateursLabel}: ${extras.contactAccompagnateur.map((c) => c.nom).join(', ')}`);
  } else if (event.encadrants?.length) {
    lines.push(`${encadrantsLabel}: ${event.encadrants.map((c) => c.nom).join(', ')}`);
  }
  return lines.join('\\n');
}

export interface IcalIdentity {
  personNom?: string;
  personId?: number;
  personType?: PersonType;
  role?: AssignmentRole | 'all';
}

export interface GenerateIcalOptions extends IcalIdentity {
  identities?: IcalIdentity[];
  timeZone?: string;
  // Namespace de l'UID (issue #278) : identifiant stable du club émetteur du flux.
  // Voir `buildEventUid` ci-dessous pour la justification.
  clubId?: string;
}

// --- UID (issue #278) --------------------------------------------------------------------
//
// `event.id` n'est unique que localement, par couple (club, type d'événement) : deux clubs
// différents — ou deux types d'événement différents au sein du même club (un match officiel
// et un entraînement, par exemple) — peuvent tout à fait partager le même `id`. Utiliser cet
// id brut comme UID iCal (RFC 5545 §3.8.4.7, censé être globalement unique et stable) exposait
// donc à des collisions : un client calendrier peut fusionner ou écraser deux événements
// distincts qui partagent le même UID. On namespace donc l'UID par type d'événement et par
// club : `<type>-<id>@<clubId>.clubika`. On ne dérive volontairement l'UID que de ces
// trois identifiants stables (jamais d'un champ éditable comme le titre, le lieu ou l'heure)
// pour que l'UID reste inchangé quand l'événement est modifié — un nouvel UID à chaque édition
// ferait perdre aux clients calendrier l'historique/les rappels associés à l'événement.
//
// ⚠️ Changement cassant pour les abonnements déjà en place : un client qui avait déjà
// synchronisé le flux avec l'ancien format `${event.id}@clubika` verra, après ce
// déploiement, chaque événement apparaître en doublon (l'ancien UID reste dans son cache tant
// qu'il n'a pas fait de resynchronisation complète du calendrier ; le nouvel UID est traité
// comme un événement inédit). Le flux est stateless — recalculé à chaque requête, sans état
// serveur sur « qui a déjà vu quel UID » — donc il n'existe pas de mécanisme pour prévenir ce
// client précis ni pour faire disparaître le doublon automatiquement. On ne conserve pas
// non plus l'ancien format en fallback : il souffre exactement de la collision qu'on corrige,
// le garder reviendrait à ne pas corriger le bug pour les clubs concernés. Le remède pour un
// abonné gêné par les doublons est de se désabonner puis se réabonner au flux (ou de forcer une
// resynchronisation complète si son application calendrier le permet) — voir aussi
// `docs/decisions/ical-uid-namespace.md`.
function sanitizeUidSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-');
}

function eventTypeKey(event: Event): string {
  if (isMatchEvent(event)) return event.type === 'amical' ? 'amical' : 'officiel';
  return event.type;
}

function buildEventUid(event: Event, clubId: string | undefined): string {
  const typeKey = sanitizeUidSegment(eventTypeKey(event));
  const idKey = sanitizeUidSegment(event.id || '');
  const namespace = sanitizeUidSegment(clubId || 'club-inconnu');
  return `${typeKey}-${idKey}@${namespace}.clubika`;
}

function contactMatches(contact: AssignmentContact, identity: IcalIdentity): boolean {
  if (assignmentStatus(contact) === 'declined') return false;
  if (identity.personId !== undefined && identity.personType) {
    return contact.personId === identity.personId && contact.personType === identity.personType;
  }
  const name = identity.personNom?.toLowerCase().trim();
  return !!name && contact.nom.toLowerCase().trim() === name;
}

function eventPublicationStatus(
  event: Event,
  allExtras: Record<string, MatchExtras>,
): ReturnType<typeof normalizePlanningStatus> {
  if (isMatchEvent(event)) {
    const extras = event.id ? allExtras[event.id] : undefined;
    return normalizePlanningStatus(extras?.planningStatus);
  }
  return normalizePlanningStatus(event.planningStatus);
}

function eventIsPublished(event: Event, allExtras: Record<string, MatchExtras>): boolean {
  return isVisiblePublicationStatus(eventPublicationStatus(event, allExtras));
}

function eventIsCancelled(event: Event, allExtras: Record<string, MatchExtras>): boolean {
  return eventPublicationStatus(event, allExtras) === 'cancelled';
}

function eventMatchesIdentity(
  event: Event,
  allExtras: Record<string, MatchExtras>,
  identity: IcalIdentity,
): boolean {
  const role = identity.role || 'all';
  if (isMatchEvent(event)) {
    const extras = event.id ? allExtras[event.id] : undefined;
    if (!extras) return false;
    const lists: Array<{ role: AssignmentRole; contacts?: AssignmentContact[] }> = [
      { role: 'arbitre', contacts: extras.arbitreTouche },
      { role: 'encadrant', contacts: extras.contactEncadrants },
      { role: 'accompagnateur', contacts: extras.contactAccompagnateur },
    ];
    return lists.some(
      (list) => (role === 'all' || role === list.role)
        && (list.contacts || []).some((contact) => contactMatches(contact, identity)),
    );
  }
  if (role !== 'all' && role !== 'encadrant') return false;
  return (event.encadrants || []).some((contact) => contactMatches(contact, identity));
}

function eventMatchesPerson(
  event: Event,
  allExtras: Record<string, MatchExtras>,
  options: GenerateIcalOptions,
): boolean {
  const identities = options.identities?.length ? options.identities : [options];
  return identities.some((identity) => eventMatchesIdentity(event, allExtras, identity));
}

export function generateIcal(
  events: Event[],
  allExtras: Record<string, MatchExtras>,
  club?: ClubInfo,
  options?: GenerateIcalOptions,
  clubAbbreviation = '',
): string {
  // Les événements annulés restent émis (avec STATUS:CANCELLED) plutôt que filtrés
  // (issue #79) : un UID qui disparaît du flux peut rester affiché comme un événement
  // normal selon le client calendrier, alors que le modèle de publication conserve
  // volontairement les annulés dans le snapshot publié pour ne pas disparaître
  // silencieusement — même principe que « Mon planning » qui les affiche « Annulé ».
  const publishedEvents = events.filter((event) =>
    eventIsPublished(event, allExtras) || eventIsCancelled(event, allExtras));
  const hasPersonFilter = options && (
    options.identities?.length
      ? options.identities.some((identity) => identity.personId !== undefined || Boolean(identity.personNom))
      : (options.personId !== undefined || Boolean(options.personNom))
  );
  const filteredEvents = hasPersonFilter && options
    ? publishedEvents.filter((event) => eventMatchesPerson(event, allExtras, options))
    : publishedEvents;

  const now = toIcalUtcTimestamp(new Date());
  const calendarName = club?.name || 'Clubika';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Clubika//FR',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${escapeIcalText(calendarName)}`,
  ];

  for (const event of filteredEvents) {
    const start = parseEventDate(event.date, event.time, options?.timeZone ?? 'UTC');
    if (!start || !event.id) continue;
    const end = new Date(start.getTime() + getEventDurationMinutes(event) * 60 * 1000);
    const extras = isMatchEvent(event) ? allExtras[event.id] : undefined;
    const cancelled = eventIsCancelled(event, allExtras);

    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${buildEventUid(event, options?.clubId)}`));
    lines.push(`DTSTAMP:${now}`);
    // SEQUENCE incrémentée pour les annulations : certains clients n'appliquent un
    // STATUS:CANCELLED que si la séquence est supérieure à la version déjà connue.
    lines.push(`SEQUENCE:${cancelled ? 1 : 0}`);
    lines.push(`DTSTART:${toIcalUtcTimestamp(start)}`);
    lines.push(`DTEND:${toIcalUtcTimestamp(end)}`);
    const title = getEventTitle(event);
    lines.push(foldLine(`SUMMARY:${escapeIcalText(cancelled ? `ANNULÉ : ${title}` : title)}`));
    if (cancelled) lines.push('STATUS:CANCELLED');
    const location = getEventLocation(event);
    if (location) lines.push(foldLine(`LOCATION:${escapeIcalText(location)}`));
    const description = getEventDescription(event, extras, clubAbbreviation);
    if (description) lines.push(foldLine(`DESCRIPTION:${escapeIcalText(description)}`));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
