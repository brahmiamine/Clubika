import {
  ALL_PLANNING_FUNCTIONS,
  PLANNING_FUNCTION_LABELS,
  normalizePlanningFunctions,
  type PlanningFunction,
} from '@/lib/auth/roles';
import {
  formatIndisponibiliteLabel,
  getIndispoTemporalStatus,
  getIndispoTimeBounds,
  normalizeIndisponibilites,
  type IndispoReviewStatus,
  type IndispoTemporalStatus,
  type OfficielIndisponibilite,
  type OfficielIndisponibiliteType,
} from '@/lib/utils/officiel-availability';
import { INDISPO_REVIEW_LABELS, reviewStatusOf } from '@/lib/indisponibilites/review';
import { publicIndispoReviewLabel } from '@/lib/privacy/health-data';

export const INDISPO_TYPE_LABELS: Record<OfficielIndisponibiliteType, string> = {
  'day-range': 'Journée / période',
  'time-slot': 'Créneau horaire',
};

export const INDISPO_TEMPORAL_LABELS: Record<IndispoTemporalStatus, string> = {
  future: 'Future',
  current: 'En cours',
  past: 'Passée',
};

export interface ClubIndisponibiliteUser {
  id: number;
  nom: string;
  planningFunctions: unknown;
  indisponibilites: unknown;
}

export interface ClubIndisponibiliteRow {
  id: string;
  indisponibiliteId: string;
  userId: number;
  userName: string;
  planningFunctions: PlanningFunction[];
  planningFunctionLabels: string[];
  type: OfficielIndisponibiliteType;
  typeLabel: string;
  dateStart: string | null;
  dateEnd: string | null;
  startTime: string | null;
  endTime: string | null;
  temporalStatus: IndispoTemporalStatus;
  temporalLabel: string;
  startAtMs: number;
  endAtMs: number;
  label: string;
  reviewStatus: IndispoReviewStatus;
  reviewLabel: string;
  reviewComment: string | null;
}

export interface ClubIndisponibiliteFilters {
  query?: string;
  planningFunction?: PlanningFunction | 'all';
  temporalStatus?: IndispoTemporalStatus | 'all';
  reviewStatus?: IndispoReviewStatus | 'all';
  sort?: 'chrono-asc' | 'chrono-desc';
}

function rowFromRule(
  user: ClubIndisponibiliteUser,
  rule: OfficielIndisponibilite,
  now: Date,
): ClubIndisponibiliteRow | null {
  const bounds = getIndispoTimeBounds(rule);
  const temporalStatus = getIndispoTemporalStatus(rule, now);
  if (!bounds || !temporalStatus) {
    return null;
  }

  const planningFunctions = normalizePlanningFunctions(user.planningFunctions);
  const dateStart = rule.dateStart ?? rule.date ?? null;
  const dateEnd = rule.dateEnd ?? rule.dateStart ?? rule.date ?? null;

  return {
    id: `${user.id}:${rule.id}`,
    indisponibiliteId: rule.id,
    userId: user.id,
    userName: user.nom,
    planningFunctions,
    planningFunctionLabels: planningFunctions.map((fn) => PLANNING_FUNCTION_LABELS[fn]),
    type: rule.type,
    typeLabel: INDISPO_TYPE_LABELS[rule.type],
    dateStart,
    dateEnd,
    startTime: rule.startTime ?? null,
    endTime: rule.endTime ?? null,
    temporalStatus,
    temporalLabel: INDISPO_TEMPORAL_LABELS[temporalStatus],
    startAtMs: bounds.startAt.getTime(),
    endAtMs: bounds.endAt.getTime(),
    label: formatIndisponibiliteLabel(rule),
    reviewStatus: reviewStatusOf(rule),
    reviewLabel: INDISPO_REVIEW_LABELS[reviewStatusOf(rule)],
    reviewComment: publicIndispoReviewLabel(rule),
  };
}

/** Aplatit les indisponibilités personnelles d'un club (une ligne par créneau). */
export function flattenClubIndisponibilites(
  users: ClubIndisponibiliteUser[],
  now: Date = new Date(),
): ClubIndisponibiliteRow[] {
  const rows: ClubIndisponibiliteRow[] = [];
  for (const user of users) {
    for (const rule of normalizeIndisponibilites(user.indisponibilites)) {
      const row = rowFromRule(user, rule, now);
      if (row) rows.push(row);
    }
  }
  return rows;
}

export function filterClubIndisponibilites(
  rows: ClubIndisponibiliteRow[],
  filters: ClubIndisponibiliteFilters = {},
): ClubIndisponibiliteRow[] {
  const query = (filters.query ?? '').trim().toLocaleLowerCase('fr');
  const planningFunction = filters.planningFunction && filters.planningFunction !== 'all'
    ? filters.planningFunction
    : null;
  const temporalStatus = filters.temporalStatus && filters.temporalStatus !== 'all'
    ? filters.temporalStatus
    : null;
  const reviewStatus = filters.reviewStatus && filters.reviewStatus !== 'all'
    ? filters.reviewStatus
    : null;

  const filtered = rows.filter((row) => {
    if (query && !row.userName.toLocaleLowerCase('fr').includes(query)) {
      return false;
    }
    if (planningFunction && !row.planningFunctions.includes(planningFunction)) {
      return false;
    }
    if (temporalStatus && row.temporalStatus !== temporalStatus) {
      return false;
    }
    if (reviewStatus && row.reviewStatus !== reviewStatus) {
      return false;
    }
    return true;
  });

  const direction = filters.sort === 'chrono-desc' ? -1 : 1;
  return [...filtered].sort((a, b) => {
    const byStart = (a.startAtMs - b.startAtMs) * direction;
    if (byStart !== 0) return byStart;
    const byName = a.userName.localeCompare(b.userName, 'fr');
    if (byName !== 0) return byName;
    return a.id.localeCompare(b.id);
  });
}

export const CLUB_INDISPO_FUNCTION_FILTERS: Array<{ value: 'all' | PlanningFunction; label: string }> = [
  { value: 'all', label: 'Toutes les fonctions' },
  ...ALL_PLANNING_FUNCTIONS.map((value) => ({ value, label: PLANNING_FUNCTION_LABELS[value] })),
];

export const CLUB_INDISPO_TEMPORAL_FILTERS: Array<{ value: 'all' | IndispoTemporalStatus; label: string }> = [
  { value: 'all', label: 'Tous les statuts temporels' },
  { value: 'future', label: INDISPO_TEMPORAL_LABELS.future },
  { value: 'current', label: INDISPO_TEMPORAL_LABELS.current },
  { value: 'past', label: INDISPO_TEMPORAL_LABELS.past },
];

export const CLUB_INDISPO_REVIEW_FILTERS: Array<{ value: 'all' | IndispoReviewStatus; label: string }> = [
  { value: 'all', label: 'Toutes les décisions' },
  { value: 'pending', label: INDISPO_REVIEW_LABELS.pending },
  { value: 'accepted', label: INDISPO_REVIEW_LABELS.accepted },
  { value: 'rejected', label: INDISPO_REVIEW_LABELS.rejected },
];
