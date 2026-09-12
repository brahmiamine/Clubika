import type { DataSource } from 'typeorm';
import { getCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';
import { listPlanningEventSnapshots, type PlanningEventSnapshot, type PlanningRole } from './event-store';
import { hydratePlanningAssignmentStates } from './assignment-state-overlay';
import {
  assignmentStatus,
  eventStartTimestamp,
  hasCoveredRole,
  needsReplacement,
  normalizePlanningStatus,
} from './p0-rules';
import { weekendWindow } from './planning-time';
import {
  DEFAULT_PUBLICATION_ROLE_REQUIREMENTS,
  requiredRolesForEvent,
  type PublicationRoleRequirements,
} from './validation';

export { weekendWindow } from './planning-time';

export interface WeekendPlanningItem {
  eventId: string;
  eventType: PlanningEventSnapshot['eventType'];
  title: string;
  date: string;
  time: string;
  location: string | null;
  planningStatus: PlanningEventSnapshot['planningStatus'];
  readiness: 'ready' | 'attention';
  missingRoles: PlanningRole[];
  replacementRoles: PlanningRole[];
  pending: number;
  declined: number;
}

export interface WeekendPlanningData {
  start: string;
  end: string;
  total: number;
  ready: number;
  attention: number;
  items: WeekendPlanningItem[];
}

export function buildWeekendPlanning(
  snapshots: PlanningEventSnapshot[],
  requirements: PublicationRoleRequirements = DEFAULT_PUBLICATION_ROLE_REQUIREMENTS,
  now = Date.now(),
  timeZone = 'UTC',
): WeekendPlanningData {
  const window = weekendWindow(now, timeZone);
  const items: WeekendPlanningItem[] = [];

  for (const snapshot of snapshots) {
    if (normalizePlanningStatus(snapshot.planningStatus) === 'cancelled') continue;
    const start = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
    if (start === null || start < window.start || start > window.end) continue;

    const missingRoles: PlanningRole[] = [];
    const replacementRoles: PlanningRole[] = [];
    let pending = 0;
    let declined = 0;

    for (const role of requiredRolesForEvent(snapshot, requirements)) {
      const contacts = snapshot.assignments[role] ?? [];
      if (!contacts.length || !hasCoveredRole(contacts)) missingRoles.push(role);
      if (needsReplacement(contacts)) replacementRoles.push(role);
      for (const contact of contacts) {
        const status = assignmentStatus(contact);
        if (status === 'pending') pending += 1;
        if (status === 'declined') declined += 1;
      }
    }

    // Le compteur `declined` reste informatif mais ne bloque pas la readiness (issue #78) :
    // un contact refusé reste dans la liste par design, et un refus déjà remplacé ne doit
    // pas marquer l'événement « attention » indéfiniment. Le cas « tous les contacts d'un
    // rôle ont refusé » est déjà couvert par `replacementRoles` (needsReplacement).
    const readiness = snapshot.planningStatus === 'published'
      && missingRoles.length === 0
      && replacementRoles.length === 0
      && pending === 0
      ? 'ready'
      : 'attention';

    items.push({
      eventId: snapshot.eventId,
      eventType: snapshot.eventType,
      title: snapshot.title,
      date: snapshot.date,
      time: snapshot.time,
      location: snapshot.location,
      planningStatus: snapshot.planningStatus,
      readiness,
      missingRoles,
      replacementRoles,
      pending,
      declined,
    });
  }

  items.sort((a, b) => (eventStartTimestamp(a.date, a.time, timeZone) ?? 0) - (eventStartTimestamp(b.date, b.time, timeZone) ?? 0));
  return {
    start: new Date(window.start).toISOString(),
    end: new Date(window.end).toISOString(),
    total: items.length,
    ready: items.filter((item) => item.readiness === 'ready').length,
    attention: items.filter((item) => item.readiness === 'attention').length,
    items,
  };
}

export async function getWeekendPlanning(db: DataSource, now = Date.now()): Promise<WeekendPlanningData> {
  const clubId = getCurrentClubId();
  const [settings, snapshots] = await Promise.all([
    readAppSettings(db, clubId),
    listPlanningEventSnapshots(db),
  ]);
  const requirements: PublicationRoleRequirements = {
    arbitre: settings.features.requireArbitreForPublication,
    encadrant: settings.features.requireEncadrantForPublication,
    accompagnateur: settings.features.requireAccompagnateurForPublication,
  };
  const hydrated = await hydratePlanningAssignmentStates(db, snapshots, clubId);
  return buildWeekendPlanning(hydrated, requirements, now, settings.timeZone);
}
