import { IsNull, type DataSource } from 'typeorm';
import type { MatchAuditLogEntity, NotificationEntity, UserEntity } from '@/lib/db/schemas';
import type { AssignmentContact } from '@/types/match';
import { getCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';
import {
  listPlanningEventSnapshots,
  type PlanningEventSnapshot,
  type PlanningRole,
} from './event-store';
import {
  assignmentStatus,
  attendanceStatus,
  eventEndTimestamp,
  eventStartTimestamp,
  hasCoveredRole,
  isAttendancePending,
  isVisiblePublicationStatus,
  needsReplacement,
  nextReminderStage,
} from './p0-rules';
import { zonedWeekday } from './planning-time';
import {
  listPublishedPlanningEventSnapshots,
  planningPublicationDiff,
  type PlanningPublicationDiff,
} from './published-planning';
import { hydratePlanningAssignmentStates } from './assignment-state-overlay';
import { requiredRolesForEvent, type PublicationRoleRequirements } from './validation';
import { createTeamLogoResolver } from './team-logos';
import { vacateDeclinedAssignmentsFromWorkingDraft } from './declined-assignment-draft';
import { filterOfficialEventsForDisplay } from './official-match-visibility';
import { auditActorLabel } from '@/lib/audit/catalog';

export interface DashboardDeclinedContact {
  nom: string;
  role: PlanningRole;
  personId?: number | null;
}

export interface DashboardAlertItem {
  eventId: string;
  eventType: PlanningEventSnapshot['eventType'];
  title: string;
  date: string;
  time: string;
  planningStatus: PlanningEventSnapshot['planningStatus'];
  missingRoles: PlanningRole[];
  replacementRoles: PlanningRole[];
  pending: number;
  declined: number;
  declinedContacts: DashboardDeclinedContact[];
  remindersDue: number;
  localTeam?: string;
  awayTeam?: string;
  localTeamLogo?: string;
  awayTeamLogo?: string;
}

export interface DashboardAttendanceItem {
  eventId: string;
  eventType: PlanningEventSnapshot['eventType'];
  title: string;
  date: string;
  time: string;
  role: PlanningRole;
  personId: number | null;
  personNom: string;
  assignmentStatus: string;
}

export interface DashboardWorkloadItem {
  identity: string;
  personId: number | null;
  personType: string | null;
  nom: string;
  upcoming: number;
  last30Days: number;
  accepted: number;
  declined: number;
  absences: number;
}

/**
 * Bloc « préparation » : tout ce qui décrit l'état du brouillon live par rapport au
 * planning réellement publié. Ces métriques servent au travail du gestionnaire (publier,
 * compléter les rôles manquants) et ne doivent jamais être lues comme l'état réel vu par
 * les utilisateurs — seules les métriques principales (issues du snapshot publié) reflètent
 * ce que chacun voit dans « Mon planning ».
 */
export interface DashboardPreparation {
  /** Le club a-t-il déjà publié un planning global ? Si non, les métriques principales retombent sur le live. */
  hasPublishedPlanning: boolean;
  publication: { draft: number; published: number; modified: number; cancelled: number };
  /** Diff structurel brouillon live vs snapshot publié (ajouts/modifications/suppressions en attente de publication). */
  unpublishedChanges: PlanningPublicationDiff;
  /** Rôles manquants sur les événements du brouillon à venir (visibles ou non encore publiés). */
  missingRoles: number;
  /** Événements brouillons ou modifiés après publication dans les 14 prochains jours. */
  alerts: DashboardAlertItem[];
}

function identity(contact: AssignmentContact): string {
  if (contact.personType && contact.personId !== undefined) return `${contact.personType}:${contact.personId}`;
  return `name:${contact.nom.trim().toLowerCase()}`;
}

function isWeekendTimestamp(timestamp: number, timeZone: string): boolean {
  const day = zonedWeekday(timestamp, timeZone);
  return day === 0 || day === 6;
}

interface EventMetrics {
  upcoming: number;
  nextWeek: number;
  weekend: number;
  complete: number;
  attention: number;
  missingRoles: number;
  pending: number;
  declined: number;
  replacements: number;
  remindersDue: number;
  attendancePending: number;
  present: number;
  excused: number;
  absent: number;
  replaced: number;
  alerts: DashboardAlertItem[];
  attendanceItems: DashboardAttendanceItem[];
  workload: Map<string, DashboardWorkloadItem>;
}

/**
 * Métriques « ce que voient les utilisateurs » calculées sur une liste d'événements
 * (typiquement le snapshot publié hydraté depuis le store opérationnel indépendant).
 * Tous les calculs temporels utilisent le fuseau horaire du club (issue #45).
 */
function computeEventMetrics(
  snapshots: PlanningEventSnapshot[],
  roleRequirements: PublicationRoleRequirements,
  now: number,
  timeZone: string,
): EventMetrics {
  const next14Days = now + 14 * 24 * 60 * 60_000;
  const next7Days = now + 7 * 24 * 60 * 60_000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60_000;
  const fourteenDaysAgo = now - 14 * 24 * 60 * 60_000;

  const metrics: EventMetrics = {
    upcoming: 0,
    nextWeek: 0,
    weekend: 0,
    complete: 0,
    attention: 0,
    missingRoles: 0,
    pending: 0,
    declined: 0,
    replacements: 0,
    remindersDue: 0,
    attendancePending: 0,
    present: 0,
    excused: 0,
    absent: 0,
    replaced: 0,
    alerts: [],
    attendanceItems: [],
    workload: new Map<string, DashboardWorkloadItem>(),
  };

  for (const snapshot of snapshots) {
    const start = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
    const end = eventEndTimestamp(snapshot.date, snapshot.time, snapshot.durationMinutes, timeZone);
    const visible = isVisiblePublicationStatus(snapshot.planningStatus);
    const operational = visible && start !== null && start >= now;
    const eventRoles = requiredRolesForEvent(snapshot, roleRequirements);
    const missing: PlanningRole[] = [];
    const replacement: PlanningRole[] = [];
    const eventDeclinedContacts: DashboardDeclinedContact[] = [];
    let eventPending = 0;
    let eventDeclined = 0;
    let eventReminders = 0;

    if (operational && start !== null) {
      metrics.upcoming += 1;
      if (start <= next7Days) metrics.nextWeek += 1;
      if (start <= next7Days && isWeekendTimestamp(start, timeZone)) metrics.weekend += 1;
    }

    for (const role of eventRoles) {
      const contacts = snapshot.assignments[role];
      if (!contacts.length) missing.push(role);
      else if (needsReplacement(contacts)) replacement.push(role);

      for (const contact of contacts) {
        const status = assignmentStatus(contact);
        if (status === 'pending') eventPending += 1;
        if (status === 'declined') {
          eventDeclined += 1;
          eventDeclinedContacts.push({
            nom: contact.nom,
            role,
            personId: contact.personId ?? null,
          });
        }
        if (visible && nextReminderStage(contact, start, now)) eventReminders += 1;

        const attendance = attendanceStatus(contact);
        if (visible && attendance === 'present') metrics.present += 1;
        if (visible && attendance === 'excused') metrics.excused += 1;
        if (visible && attendance === 'absent') metrics.absent += 1;
        if (visible && attendance === 'replaced') metrics.replaced += 1;

        if (visible && isAttendancePending(contact, end, now) && end !== null && end >= fourteenDaysAgo) {
          metrics.attendancePending += 1;
          metrics.attendanceItems.push({
            eventId: snapshot.eventId,
            eventType: snapshot.eventType,
            title: snapshot.title,
            date: snapshot.date,
            time: snapshot.time,
            role,
            personId: contact.personId ?? null,
            personNom: contact.nom,
            assignmentStatus: status,
          });
        }

        const key = identity(contact);
        const current = metrics.workload.get(key) ?? {
          identity: key,
          personId: contact.personId ?? null,
          personType: contact.personType ?? null,
          nom: contact.nom,
          upcoming: 0,
          last30Days: 0,
          accepted: 0,
          declined: 0,
          absences: 0,
        };
        if (visible && start !== null && status !== 'declined') {
          if (start >= now) current.upcoming += 1;
          if (start >= thirtyDaysAgo && start < now) current.last30Days += 1;
        }
        if (visible && status === 'accepted') current.accepted += 1;
        if (visible && status === 'declined') current.declined += 1;
        if (visible && attendance === 'absent') current.absences += 1;
        metrics.workload.set(key, current);
      }
    }

    if (operational) {
      metrics.missingRoles += missing.length;
      metrics.replacements += replacement.length;
      metrics.pending += eventPending;
      metrics.declined += eventDeclined;
      metrics.remindersDue += eventReminders;
    }

    const eventComplete = operational
      && missing.length === 0
      && replacement.length === 0
      && eventPending === 0
      && eventDeclined === 0
      && eventRoles.every((role) => hasCoveredRole(snapshot.assignments[role]));
    if (eventComplete) metrics.complete += 1;

    const needsAttention = operational
      && (missing.length > 0 || replacement.length > 0 || eventPending > 0 || eventDeclined > 0 || eventReminders > 0);
    if (needsAttention) metrics.attention += 1;

    if (
      start !== null
      && start >= now
      && start <= next14Days
      && (
        needsAttention
        || snapshot.planningStatus === 'draft'
        || snapshot.planningStatus === 'modified'
        || snapshot.planningStatus === 'cancelled'
      )
    ) {
      metrics.alerts.push({
        eventId: snapshot.eventId,
        eventType: snapshot.eventType,
        title: snapshot.title,
        date: snapshot.date,
        time: snapshot.time,
        planningStatus: snapshot.planningStatus,
        missingRoles: missing,
        replacementRoles: replacement,
        pending: eventPending,
        declined: eventDeclined,
        declinedContacts: eventDeclinedContacts,
        remindersDue: eventReminders,
      });
    }
  }

  metrics.alerts.sort((a, b) => (eventStartTimestamp(a.date, a.time, timeZone) ?? 0) - (eventStartTimestamp(b.date, b.time, timeZone) ?? 0));
  metrics.attendanceItems.sort((a, b) => (eventStartTimestamp(b.date, b.time, timeZone) ?? 0) - (eventStartTimestamp(a.date, a.time, timeZone) ?? 0));

  return metrics;
}

/**
 * Métriques de préparation sur le brouillon live : compteurs par statut de publication et
 * rôles encore manquants sur les événements à venir non publiés ou modifiés.
 */
function computePreparationAlerts(
  snapshots: PlanningEventSnapshot[],
  roleRequirements: PublicationRoleRequirements,
  now: number,
  timeZone: string,
): { alerts: DashboardAlertItem[]; missingRoles: number } {
  const next14Days = now + 14 * 24 * 60 * 60_000;
  const alerts: DashboardAlertItem[] = [];
  let missingRoles = 0;

  for (const snapshot of snapshots) {
    const start = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
    if (start === null || start < now || start > next14Days) continue;

    const unpublishedWork = snapshot.planningStatus === 'draft' || snapshot.planningStatus === 'modified';
    const eventRoles = requiredRolesForEvent(snapshot, roleRequirements);
    const missing: PlanningRole[] = eventRoles.filter((role) => snapshot.assignments[role].length === 0);
    if (!unpublishedWork && missing.length === 0) continue;

    missingRoles += missing.length;
    alerts.push({
      eventId: snapshot.eventId,
      eventType: snapshot.eventType,
      title: snapshot.title,
      date: snapshot.date,
      time: snapshot.time,
      planningStatus: snapshot.planningStatus,
      missingRoles: missing,
      replacementRoles: [],
      pending: 0,
      declined: 0,
      declinedContacts: [],
      remindersDue: 0,
    });
  }

  alerts.sort((a, b) => (eventStartTimestamp(a.date, a.time, timeZone) ?? 0) - (eventStartTimestamp(b.date, b.time, timeZone) ?? 0));
  return { alerts, missingRoles };
}

export async function buildClubDashboardData(
  db: DataSource,
  userId: number,
  now = Date.now(),
) {
  const clubId = getCurrentClubId();
  try {
    await vacateDeclinedAssignmentsFromWorkingDraft(db, clubId);
  } catch (error) {
    console.error('Impossible d’aligner le brouillon sur les refus d’affectation:', error);
  }
  const [snapshots, publishedSnapshots, users, unreadNotifications, recentNotifications, recentAudit, settings] = await Promise.all([
    listPlanningEventSnapshots(db),
    listPublishedPlanningEventSnapshots(db, clubId),
    db.getRepository<UserEntity>('User').find(),
    db.getRepository<NotificationEntity>('Notification').count({ where: { userId, readAt: IsNull() } }),
    db.getRepository<NotificationEntity>('Notification').find({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: 8,
    }),
    // Audit récent borné au club courant (issue #126).
    db.getRepository<MatchAuditLogEntity>('MatchAuditLog').find({
      where: { clubId },
      order: { createdAt: 'DESC' },
      take: 10,
    }),
    readAppSettings(db, clubId),
  ]);
  const roleRequirements: PublicationRoleRequirements = {
    arbitre: settings.features.requireArbitreForPublication,
    encadrant: settings.features.requireEncadrantForPublication,
    accompagnateur: settings.features.requireAccompagnateurForPublication,
  };
  // Tous les calculs temporels du dashboard utilisent le fuseau horaire du club (issue #45).
  const timeZone = settings.timeZone;
  const liveSnapshots = filterOfficialEventsForDisplay(snapshots, settings, now);
  const publishedForDisplay = publishedSnapshots === null
    ? null
    : filterOfficialEventsForDisplay(publishedSnapshots, settings, now);

  // Issue #39 : les métriques principales reflètent exactement ce que voient les utilisateurs
  // dans « Mon planning » — le snapshot publié, hydraté depuis le store opérationnel
  // (réponses, relances, présences). Le brouillon live n'alimente que le bloc `preparation`.
  // Si le club n'a encore jamais publié, on retombe sur le live pour ne pas afficher un
  // dashboard vide (le bloc `preparation.hasPublishedPlanning` permet à l'UI de le signaler).
  const hasPublishedPlanning = publishedForDisplay !== null;
  const operationalSnapshots = hasPublishedPlanning
    ? await hydratePlanningAssignmentStates(db, publishedForDisplay, clubId)
    : liveSnapshots;

  const operational = computeEventMetrics(operationalSnapshots, roleRequirements, now, timeZone);
  const preparationWork = computePreparationAlerts(liveSnapshots, roleRequirements, now, timeZone);

  // Noms + logos des équipes pour chaque alerte (affichage « logo + nom » côté UI).
  const teamLogos = await createTeamLogoResolver(db, clubId);
  const snapshotByKey = new Map<string, PlanningEventSnapshot>();
  for (const snapshot of [...operationalSnapshots, ...liveSnapshots]) {
    snapshotByKey.set(`${snapshot.eventType}:${snapshot.eventId}`, snapshot);
  }
  const withTeamLogos = (list: DashboardAlertItem[]): DashboardAlertItem[] => list.map((item) => ({
    ...item,
    ...teamLogos(snapshotByKey.get(`${item.eventType}:${item.eventId}`)?.event),
  }));

  const publication = { draft: 0, published: 0, modified: 0, cancelled: 0 };
  for (const snapshot of liveSnapshots) {
    publication[snapshot.planningStatus] += 1;
  }

  const preparation: DashboardPreparation = {
    hasPublishedPlanning,
    publication,
    unpublishedChanges: planningPublicationDiff(liveSnapshots, publishedForDisplay ?? []),
    missingRoles: preparationWork.missingRoles,
    alerts: withTeamLogos(preparationWork.alerts.slice(0, 30)),
  };

  const activeUsers = users.filter((user) => user.active);
  const userRoles = activeUsers.reduce<Record<string, number>>((acc, user) => {
    acc[user.accessRole] = (acc[user.accessRole] ?? 0) + 1;
    for (const planningFunction of user.planningFunctions ?? []) {
      acc[planningFunction] = (acc[planningFunction] ?? 0) + 1;
    }
    return acc;
  }, {});

  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      events: operationalSnapshots.length,
      upcoming: operational.upcoming,
      nextWeek: operational.nextWeek,
      weekend: operational.weekend,
      complete: operational.complete,
      attention: operational.attention,
      missingRoles: operational.missingRoles,
      pending: operational.pending,
      declined: operational.declined,
      replacements: operational.replacements,
      remindersDue: operational.remindersDue,
      attendancePending: operational.attendancePending,
      present: operational.present,
      excused: operational.excused,
      absent: operational.absent,
      replaced: operational.replaced,
      unreadNotifications,
      activeUsers: activeUsers.length,
    },
    publication,
    preparation,
    usersByRole: userRoles,
    alerts: withTeamLogos(operational.alerts.slice(0, 30)),
    attendance: operational.attendanceItems.slice(0, 40),
    workload: Array.from(operational.workload.values())
      .sort((a, b) => b.upcoming - a.upcoming || b.last30Days - a.last30Days || a.nom.localeCompare(b.nom, 'fr'))
      .slice(0, 30),
    recentNotifications: recentNotifications.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      message: item.message,
      eventType: item.eventType,
      eventId: item.eventId,
      readAt: item.readAt,
      createdAt: item.createdAt,
    })),
    recentAudit: recentAudit.map((item) => ({
      id: item.id,
      entityType: item.entityType,
      entityId: item.entityId,
      action: item.action,
      actorLabel: auditActorLabel(item.userId),
      createdAt: item.createdAt,
    })),
  };
}
