import type { DataSource } from 'typeorm';
import type { SessionUser } from '@/lib/auth/session';
import type {
  AssignmentContact,
  AssignmentStatus,
  AttendanceStatus,
  DeclineReason,
  Entrainement,
  Match,
  Plateau,
} from '@/types/match';
import type { MatchExtras } from '@/hooks/useMatchExtras';
import { functionForPlanningRole, personIdentityMatches } from './person-link';
import { extractMinutes, normalizeDateValue } from '@/lib/utils/officiel-availability';
import { hasPlanningFunction } from '@/lib/auth/roles';
import { listPublishedPlanningEventSnapshots } from './published-planning';
import { hydratePlanningAssignmentStates } from './assignment-state-overlay';
import { createTeamLogoResolver } from './team-logos';
import { readAppSettings } from '@/lib/settings-store';
import { filterOfficialEventsForDisplay } from './official-match-visibility';
import {
  assignmentStatus,
  attendanceStatus,
  eventEndTimestamp,
  eventStartTimestamp,
  isAttendancePending,
  isVisiblePublicationStatus,
  normalizePlanningStatus,
} from './p0-rules';
import { zonedDayStart } from './planning-time';
import type { EventWeatherDisplay } from './weather-condition';

export type PersonalEventType = 'officiel' | 'amical' | 'entrainement' | 'plateau';
export type PersonalAssignmentRole = 'arbitre' | 'encadrant' | 'accompagnateur';

export interface PersonalAssignment {
  assignmentId: string;
  eventId: string;
  eventType: PersonalEventType;
  role: PersonalAssignmentRole;
  /** Fonctions publiées réellement tenues par cette personne sur cet événement. */
  roles: PersonalAssignmentRole[];
  status: AssignmentStatus;
  attendanceStatus: AttendanceStatus;
  respondedAt: string | null;
  /** Motif et commentaire de refus enregistrés avec la réponse, réexposés après rechargement (issue #44). */
  declineReason: DeclineReason | null;
  declineComment: string | null;
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
  /** Événement annulé après avoir déjà été publié : reste visible avec ce drapeau plutôt que de disparaître. */
  cancelled: boolean;
}

export interface PersonalPlanningStats {
  /** Nombre d'événements distincts, tous statuts confondus (issue #281). */
  totalEvents: number;
  /** Nombre d'affectations (une par fonction publiée) ; un dirigeant multi-fonctions
   *  fait dépasser ce total à `totalEvents` sur un même événement (issue #281). */
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
  present: number;
  excused: number;
  absent: number;
  replaced: number;
  attendancePending: number;
}

/**
 * Une carte « Mon planning » par événement (issue #281) : un dirigeant tenant plusieurs
 * fonctions sur le même événement (ex. Arbitre club + Encadrant) voyait auparavant une
 * carte par fonction, chacune ré-affichant l'ensemble des fonctions publiées mais avec un
 * statut/une action différents. Ici chaque événement n'apparaît qu'une fois, avec la liste
 * de ses fonctions (`functions`) — chacune conservant son propre statut et sa propre action
 * de réponse indépendante.
 */
export interface PersonalPlanningEvent {
  /** `${eventType}:${eventId}`, la même clé d'unicité événement utilisée dans tout le
   *  module planning (cf. `published-planning.ts`, `assignment-state-overlay.ts`, etc.). */
  eventKey: string;
  eventId: string;
  eventType: PersonalEventType;
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
  /** Une entrée par fonction tenue par l'utilisateur sur cet événement, dans l'ordre où
   *  elles ont été publiées ; chacune garde son `assignmentId` propre pour la réponse
   *  (accepter/refuser) et son statut indépendant. */
  functions: PersonalAssignment[];
  /** Prévision à l’heure de l’événement, si la météo est activée. */
  weather?: EventWeatherDisplay | null;
}

/**
 * Regroupe les affectations plates (une par fonction) par événement. Ne fait aucune
 * hypothèse hors des champs déjà présents sur `PersonalAssignment` : les champs communs à
 * l'événement (date, lieu, logos...) sont repris de la première fonction rencontrée, les
 * fonctions elles-mêmes restant chacune indépendante (statut, réponse, motif de refus).
 */
export function groupPersonalAssignmentsByEvent(
  assignments: PersonalAssignment[],
): PersonalPlanningEvent[] {
  const eventsByKey = new Map<string, PersonalPlanningEvent>();
  for (const assignment of assignments) {
    const eventKey = `${assignment.eventType}:${assignment.eventId}`;
    const existing = eventsByKey.get(eventKey);
    if (existing) {
      existing.functions.push(assignment);
      continue;
    }
    eventsByKey.set(eventKey, {
      eventKey,
      eventId: assignment.eventId,
      eventType: assignment.eventType,
      date: assignment.date,
      time: assignment.time,
      durationMinutes: assignment.durationMinutes,
      title: assignment.title,
      localTeam: assignment.localTeam,
      awayTeam: assignment.awayTeam,
      localTeamLogo: assignment.localTeamLogo,
      awayTeamLogo: assignment.awayTeamLogo,
      categorie: assignment.categorie,
      lieu: assignment.lieu,
      adresse: assignment.adresse,
      itineraryLink: assignment.itineraryLink,
      rendezVous: assignment.rendezVous,
      seriesId: assignment.seriesId,
      confirmed: assignment.confirmed,
      cancelled: assignment.cancelled,
      functions: [assignment],
    });
  }
  // `assignments` est déjà trié chronologiquement par `listPersonalAssignments` ; une Map
  // conserve l'ordre de première insertion, donc le regroupement reste trié.
  return [...eventsByKey.values()];
}

function matchContact(user: SessionUser, contact: AssignmentContact): boolean {
  return personIdentityMatches(contact, user);
}

function dateTimeValue(date: string, time: string): number {
  const normalized = normalizeDateValue(date);
  if (!normalized) return 0;
  const [dayRaw, monthRaw, yearRaw] = normalized.split('/');
  const day = Number.parseInt(dayRaw ?? '', 10);
  const month = Number.parseInt(monthRaw ?? '', 10);
  const year = Number.parseInt(yearRaw ?? '', 10);
  const minutes = extractMinutes(time) ?? 0;
  if (!day || !month || !year) return 0;
  return Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
}

const PERSONAL_ASSIGNMENT_ROLES: PersonalAssignmentRole[] = ['arbitre', 'encadrant', 'accompagnateur'];

const CONTACTS_BY_ROLE: Record<
  PersonalAssignmentRole,
  keyof Pick<MatchExtras, 'arbitreTouche' | 'contactEncadrants' | 'contactAccompagnateur'>
> = {
  arbitre: 'arbitreTouche',
  encadrant: 'contactEncadrants',
  accompagnateur: 'contactAccompagnateur',
};

function buildMatchAssignments(
  user: SessionUser,
  eventType: 'officiel' | 'amical',
  match: Match,
  extras: MatchExtras | undefined,
  allowCancelled = false,
): PersonalAssignment[] {
  if (!match.id || !extras) return [];
  const status = normalizePlanningStatus(extras.planningStatus);
  const cancelled = status === 'cancelled';
  // Un événement déjà publié puis annulé reste visible (avec le drapeau `cancelled`) dans le
  // snapshot publié appelant (cf. issue #40) ; ailleurs, un événement annulé n'a jamais été
  // montré à personne et reste donc masqué.
  if (!isVisiblePublicationStatus(status) && !(allowCancelled && cancelled)) return [];

  const assignments: PersonalAssignment[] = [];
  for (const role of PERSONAL_ASSIGNMENT_ROLES) {
    if (!hasPlanningFunction(user.planningFunctions, functionForPlanningRole(role))) continue;
    const field = CONTACTS_BY_ROLE[role];
    const contacts = extras[field];
    const contact = contacts?.find((item) => matchContact(user, item));
    if (!contact) continue;

    assignments.push({
      assignmentId: `${eventType}:${match.id}:${role}`,
      eventId: match.id,
      eventType,
      role,
      roles: [role],
      status: assignmentStatus(contact),
      attendanceStatus: attendanceStatus(contact),
      respondedAt: contact.respondedAt ?? null,
      declineReason: contact.declineReason ?? null,
      declineComment: contact.declineComment ?? null,
      date: match.date,
      time: match.time,
      durationMinutes: match.durationMinutes ?? 90,
      title: `${match.localTeam} – ${match.awayTeam}`,
      categorie: match.categorie ?? match.competition ?? null,
      lieu: match.details?.stadium ?? null,
      adresse: match.details?.address ?? null,
      itineraryLink: match.details?.itineraryLink ?? null,
      rendezVous: match.horaireRendezVous || null,
      seriesId: match.seriesId ?? null,
      confirmed: extras.confirmed ?? null,
      cancelled,
    });
  }
  return assignments;
}

function buildSimpleAssignment(
  user: SessionUser,
  eventType: 'entrainement' | 'plateau',
  event: Entrainement | Plateau,
  allowCancelled = false,
): PersonalAssignment | null {
  if (!hasPlanningFunction(user.planningFunctions, 'encadrant')) return null;
  const status = normalizePlanningStatus(event.planningStatus);
  const cancelled = status === 'cancelled';
  if (!isVisiblePublicationStatus(status) && !(allowCancelled && cancelled)) return null;
  const contact = event.encadrants?.find((item) => matchContact(user, item));
  if (!contact) return null;

  const categorie = event.type === 'entrainement'
    ? event.categorie ?? null
    : event.categories?.join(', ') ?? null;

  return {
    assignmentId: `${eventType}:${event.id}:encadrant`,
    eventId: event.id,
    eventType,
    role: 'encadrant',
    roles: ['encadrant'],
    status: assignmentStatus(contact),
    attendanceStatus: attendanceStatus(contact),
    respondedAt: contact.respondedAt ?? null,
    declineReason: contact.declineReason ?? null,
    declineComment: contact.declineComment ?? null,
    date: event.date,
    time: event.time,
    durationMinutes: event.durationMinutes ?? 90,
    title: event.type === 'entrainement' ? 'Entraînement' : 'Plateau',
    categorie,
    lieu: event.lieu || null,
    adresse: null,
    itineraryLink: null,
    rendezVous: null,
    seriesId: event.seriesId ?? null,
    confirmed: null,
    cancelled,
  };
}

export async function listPersonalAssignments(
  db: DataSource,
  user: SessionUser,
): Promise<PersonalAssignment[]> {
  const publishedSnapshots = await listPublishedPlanningEventSnapshots(db, user.clubId);
  // Avant la première publication globale, rien n'est visible (issue #94) : les données
  // live/legacy — statut absent ou marqué publié hors workflow — ne sont plus une source
  // utilisateur. La migration (`normalizeLegacyPlanningPayload`) les range en brouillon ;
  // elles ne deviennent visibles que via le bouton « Publier le planning ».
  if (!publishedSnapshots) return [];

  const settings = await readAppSettings(db, user.clubId);
  const effectiveSnapshots = filterOfficialEventsForDisplay(
    await hydratePlanningAssignmentStates(db, publishedSnapshots, user.clubId),
    settings,
  );
  const publishedAssignments: PersonalAssignment[] = [];
  for (const snapshot of effectiveSnapshots) {
    if (snapshot.eventType === 'officiel' || snapshot.eventType === 'amical') {
      publishedAssignments.push(...buildMatchAssignments(
        user,
        snapshot.eventType,
        snapshot.event as Match,
        snapshot.extras ?? undefined,
        true,
      ));
    } else {
      const item = buildSimpleAssignment(
        user,
        snapshot.eventType,
        snapshot.event as Entrainement | Plateau,
        true,
      );
      if (item) publishedAssignments.push(item);
    }
  }
  // Un même dirigeant peut tenir plusieurs fonctions sur un événement. Chaque
  // affectation reste indépendante pour la réponse, tandis que chaque carte expose
  // l'ensemble des fonctions réellement publiées, sans doublon (issue #210).
  const rolesByEvent = new Map<string, PersonalAssignmentRole[]>();
  for (const assignment of publishedAssignments) {
    const key = `${assignment.eventType}:${assignment.eventId}`;
    const roles = rolesByEvent.get(key) ?? [];
    if (!roles.includes(assignment.role)) roles.push(assignment.role);
    rolesByEvent.set(key, roles);
  }

  // Noms + logos des équipes pour chaque affectation « match » (affichage « logo + nom »).
  const teamLogos = await createTeamLogoResolver(db, user.clubId);
  const eventByKey = new Map(
    effectiveSnapshots.map((snapshot) => [`${snapshot.eventType}:${snapshot.eventId}`, snapshot.event] as const),
  );
  return publishedAssignments
    .map((item) => ({
      ...item,
      roles: rolesByEvent.get(`${item.eventType}:${item.eventId}`) ?? [item.role],
      ...teamLogos(eventByKey.get(`${item.eventType}:${item.eventId}`)),
    }))
    .sort((a, b) => dateTimeValue(a.date, a.time) - dateTimeValue(b.date, b.time));
}

export function buildPersonalPlanningStats(
  assignments: PersonalAssignment[],
  /** Fuseau horaire du club pour le calcul début/fin (issue #45). */
  timeZone = 'UTC',
): PersonalPlanningStats {
  const now = Date.now();
  // « Passé » se calcule à la journée près (fuseau du club) : un événement du jour
  // reste compté dans « à venir » jusqu'au lendemain, même terminé — cohérent avec
  // les listes « Prochaines affectations » / « Historique » de /mon-planning.
  const startOfToday = zonedDayStart(now, timeZone);

  const stats: PersonalPlanningStats = {
    totalEvents: 0,
    totalAssignments: assignments.length,
    upcomingEvents: 0,
    pastEvents: 0,
    pending: 0,
    accepted: 0,
    declined: 0,
    officiel: 0,
    amical: 0,
    entrainement: 0,
    plateau: 0,
    present: 0,
    excused: 0,
    absent: 0,
    replaced: 0,
    attendancePending: 0,
  };

  // Les métriques « événement » (issue #281) se calculent sur les événements distincts :
  // un dirigeant multi-fonctions ne doit pas faire compter deux fois le même événement
  // dans « Total », « À venir », « Historique » ou la répartition par type.
  const events = groupPersonalAssignmentsByEvent(assignments);
  stats.totalEvents = events.length;
  for (const event of events) {
    const dayStart = eventStartTimestamp(event.date, '00:00', timeZone);
    if (dayStart !== null && dayStart < startOfToday) stats.pastEvents += 1;
    else stats.upcomingEvents += 1;
    stats[event.eventType] += 1;
  }

  // Les métriques « affectation » (statut de réponse, présence) restent par fonction :
  // chaque fonction d'un même événement conserve son propre statut et son propre suivi
  // de présence, indépendamment des autres fonctions tenues sur cet événement.
  for (const assignment of assignments) {
    stats[assignment.status] += 1;

    if (assignment.attendanceStatus === 'present') stats.present += 1;
    if (assignment.attendanceStatus === 'excused') stats.excused += 1;
    if (assignment.attendanceStatus === 'absent') stats.absent += 1;
    if (assignment.attendanceStatus === 'replaced') stats.replaced += 1;

    const end = eventEndTimestamp(assignment.date, assignment.time, assignment.durationMinutes, timeZone);
    const syntheticContact: AssignmentContact = {
      nom: '',
      numero: '',
      status: assignment.status,
      attendanceStatus: assignment.attendanceStatus,
    };
    if (isAttendancePending(syntheticContact, end, now)) stats.attendancePending += 1;
  }

  return stats;
}
