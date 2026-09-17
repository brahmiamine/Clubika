import type { DataSource } from 'typeorm';
import type { AssignmentContact } from '@/types/match';
import { getCurrentClubId } from '@/lib/auth/club-context';
import { readAppSettings } from '@/lib/settings-store';
import { parsePositiveInt, retentionCutoff } from '@/lib/retention/policy';
import { listPlanningEventSnapshots, type PlanningEventSnapshot } from './event-store';
import { assignmentStatus, attendanceStatus, eventStartTimestamp, isVisiblePublicationStatus, needsReplacement } from './p0-rules';
import {
  listPublishedPlanningEventSnapshots,
} from './published-planning';
import { hydratePlanningAssignmentStates } from './assignment-state-overlay';
import {
  DEFAULT_PUBLICATION_ROLE_REQUIREMENTS,
  requiredRolesForEvent,
  type PublicationRoleRequirements,
} from './validation';

/**
 * Fenêtre glissante par défaut de l'analyse (issue #16) : les statistiques nominatives
 * et globales ne portent jamais sur tout l'historique du planning, seulement sur les
 * `periodDays` derniers jours (les événements futurs déjà publiés restent inclus, la
 * borne ne porte que sur le passé). Alignée sur l'ordre de grandeur d'une saison sportive.
 * Configurable par club via la variable d'environnement ci-dessous, à la manière des
 * politiques de rétention (`app/lib/retention/policy.ts`).
 */
export const PLANNING_ANALYTICS_PERIOD_ENV_KEY = 'PLANNING_ANALYTICS_PERIOD_DAYS';
export const DEFAULT_PLANNING_ANALYTICS_PERIOD_DAYS = 180;

export function planningAnalyticsPeriodDays(env: Record<string, string | undefined> = process.env): number {
  return parsePositiveInt(env[PLANNING_ANALYTICS_PERIOD_ENV_KEY], DEFAULT_PLANNING_ANALYTICS_PERIOD_DAYS);
}

/**
 * Indicateur nominatif minimal (issue #16 — « Minimiser les statistiques nominatives du
 * planning »). Le seul champ individuel conservé est le nombre d'affectations : il suffit
 * à équilibrer la charge entre les personnes (répartir les sollicitations) sans exposer de
 * classement de performance individuelle. Les refus, présences et absences nominatifs ont
 * été retirés de l'API : ils n'étaient pas affichés côté client et ne sont pas justifiés
 * pour l'objectif de couverture/équité poursuivi ici. Leurs équivalents agrégés restent
 * disponibles sur `PlanningAnalytics` (acceptanceRate, attendanceRate, declineRate...).
 */
export interface PlanningWorkloadMetric {
  /** Identifiant stable de la personne (type + id, ou nom normalisé en repli), interne au club. */
  identity: string;
  /** Nom affiché à l'admin pour situer la charge — jamais utilisé pour classer les personnes. */
  nom: string;
  /** Nombre d'affectations sur la période analysée (cf. `PlanningAnalytics.analyzedPeriod`). */
  assignments: number;
}

export interface PlanningAnalytics {
  /** Nombre d'événements visibles (publiés/modifiés) dans la période analysée. */
  events: number;
  /** Nombre de créneaux de rôle requis sur la période (mesure la charge de couverture à assurer). */
  requiredRoles: number;
  /** Rôles requis jamais assignés sur la période (distinct des remplacements, cf. missingCoverageRate). */
  missingRoles: number;
  /** Nombre total d'affectations (tous statuts) sur la période — indicateur de charge globale. */
  assignments: number;
  /** Affectations ayant reçu une réponse (acceptée ou refusée) sur la période. */
  respondedAssignments: number;
  /** Taux d'acceptation global — indicateur d'équité/adhésion, jamais nominatif. */
  acceptanceRate: number;
  /** Taux de présence global — indicateur de couverture réelle, jamais nominatif. */
  attendanceRate: number;
  averageResponseDelayMinutes: number | null;
  /** Part des rôles requis restés sans couverture active après refus (cf. needsReplacement()). */
  replacementRate: number;
  /** Taux de refus brut (déclinés / affectations ayant répondu) — pas un indicateur de besoin réel de remplacement. */
  declineRate: number;
  missingCoverageRate: number;
  /** Coefficient d'équité de charge (1 = répartition parfaite) — dérivé de `workload`, jamais un classement. */
  fairnessCoefficient: number;
  /** Vue nominative minimale (issue #16) : uniquement le nombre d'affectations par personne. */
  workload: PlanningWorkloadMetric[];
  /**
   * Période effectivement analysée (issue #16) : les indicateurs ci-dessus, y compris
   * `workload`, ne portent jamais sur tout l'historique — uniquement sur cette fenêtre.
   */
  analyzedPeriod: {
    /** Nombre de jours en amont de `to` pris en compte. */
    days: number;
    /** Borne basse (ISO 8601) — les événements antérieurs sont exclus. */
    from: string;
    /** Borne haute (ISO 8601), généralement l'instant du calcul. */
    to: string;
  };
}

function identity(contact: AssignmentContact): string {
  if (contact.personType && contact.personId !== undefined) return `${contact.personType}:${contact.personId}`;
  return `name:${contact.nom.trim().toLowerCase()}`;
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
}

export function fairnessCoefficient(loads: number[]): number {
  if (!loads.length) return 1;
  const normalized = loads.map((value) => Math.max(0, value));
  const total = normalized.reduce((sum, value) => sum + value, 0);
  if (total === 0) return 1;
  const n = normalized.length;
  let pairwise = 0;
  for (const a of normalized) {
    for (const b of normalized) pairwise += Math.abs(a - b);
  }
  const gini = pairwise / (2 * n * total);
  return Math.round((1 - gini) * 10_000) / 10_000;
}

export interface PlanningAnalyticsOptions {
  /** Nombre de jours de recul pris en compte (défaut : `DEFAULT_PLANNING_ANALYTICS_PERIOD_DAYS`). */
  periodDays?: number;
  /** Instant de référence pour la borne haute de la période (défaut : `new Date()`). Utile pour des tests déterministes. */
  now?: Date;
  /** Fuseau horaire utilisé pour dater les événements (défaut : `'UTC'`). */
  timeZone?: string;
}

export function computePlanningAnalytics(
  snapshots: PlanningEventSnapshot[],
  requirements: PublicationRoleRequirements = DEFAULT_PUBLICATION_ROLE_REQUIREMENTS,
  options: PlanningAnalyticsOptions = {},
): PlanningAnalytics {
  const periodDays = options.periodDays ?? DEFAULT_PLANNING_ANALYTICS_PERIOD_DAYS;
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? 'UTC';
  const cutoff = retentionCutoff(periodDays, now);
  const cutoffMs = cutoff.getTime();
  const nowMs = now.getTime();

  // Fenêtre bornée (issue #16) : on n'agrège jamais tout l'historique. Un événement dont la
  // date ne peut pas être interprétée est conservé par défaut plutôt que silencieusement
  // exclu, pour ne pas fausser la couverture en cas de donnée legacy malformée.
  const withinPeriod = snapshots.filter((snapshot) => {
    const start = eventStartTimestamp(snapshot.date, snapshot.time, timeZone);
    return start === null || start >= cutoffMs;
  });

  const visible = withinPeriod.filter((snapshot) => isVisiblePublicationStatus(snapshot.planningStatus));
  let requiredRoleCount = 0;
  let missingRoles = 0;
  let replacementsNeeded = 0;
  let assignments = 0;
  let accepted = 0;
  let declined = 0;
  let present = 0;
  let knownAttendance = 0;
  let responseDelayTotal = 0;
  let responseDelayCount = 0;
  const workload = new Map<string, PlanningWorkloadMetric>();

  for (const snapshot of visible) {
    for (const role of requiredRolesForEvent(snapshot, requirements)) {
      requiredRoleCount += 1;
      const contacts = snapshot.assignments[role] ?? [];
      if (!contacts.some((contact) => assignmentStatus(contact) !== 'declined')) {
        missingRoles += 1;
      }
      // Besoin réel de remplacement (issue #220) : un rôle qui AVAIT des contacts mais dont
      // plus aucun n'est actif après refus — même définition que needsReplacement()/
      // dashboard-data.ts. Un rôle jamais assigné (contacts vide) n'est pas un « remplacement »,
      // c'est déjà couvert par missingCoverageRate ci-dessus.
      if (contacts.length > 0 && needsReplacement(contacts)) {
        replacementsNeeded += 1;
      }
    }

    for (const contacts of Object.values(snapshot.assignments)) {
      for (const contact of contacts) {
        assignments += 1;
        const status = assignmentStatus(contact);
        if (status === 'accepted') accepted += 1;
        if (status === 'declined') declined += 1;

        if (contact.assignedAt && contact.respondedAt) {
          const assignedAt = Date.parse(contact.assignedAt);
          const respondedAt = Date.parse(contact.respondedAt);
          if (Number.isFinite(assignedAt) && Number.isFinite(respondedAt) && respondedAt >= assignedAt) {
            responseDelayTotal += (respondedAt - assignedAt) / 60_000;
            responseDelayCount += 1;
          }
        }

        const attendance = attendanceStatus(contact);
        if (attendance !== 'unknown' && attendance !== 'replaced') knownAttendance += 1;
        if (attendance === 'present') present += 1;

        // Vue nominative volontairement minimale (issue #16) : seul le décompte des
        // affectations est conservé par personne. Les refus/présences/absences individuels
        // ne sont ni calculés ni exposés ici — leurs agrégats globaux le sont plus haut.
        const key = identity(contact);
        const current = workload.get(key) ?? {
          identity: key,
          nom: contact.nom,
          assignments: 0,
        };
        current.assignments += 1;
        workload.set(key, current);
      }
    }
  }

  const respondedAssignments = accepted + declined;
  // Tri alphabétique, jamais par charge décroissante (issue #16) : la vue nominative ne doit
  // pas se lire comme un classement de performance individuelle.
  const workloadList = Array.from(workload.values())
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

  return {
    events: visible.length,
    requiredRoles: requiredRoleCount,
    missingRoles,
    assignments,
    respondedAssignments,
    acceptanceRate: percent(accepted, respondedAssignments),
    attendanceRate: percent(present, knownAttendance),
    averageResponseDelayMinutes: responseDelayCount
      ? Math.round((responseDelayTotal / responseDelayCount) * 100) / 100
      : null,
    replacementRate: percent(replacementsNeeded, requiredRoleCount),
    declineRate: percent(declined, respondedAssignments),
    missingCoverageRate: percent(missingRoles, requiredRoleCount),
    fairnessCoefficient: fairnessCoefficient(workloadList.map((item) => item.assignments)),
    workload: workloadList,
    analyzedPeriod: {
      days: periodDays,
      from: cutoff.toISOString(),
      to: new Date(nowMs).toISOString(),
    },
  };
}

export async function buildPlanningAnalytics(db: DataSource): Promise<PlanningAnalytics> {
  const clubId = getCurrentClubId();
  const [settings, snapshots, publishedSnapshots] = await Promise.all([
    readAppSettings(db, clubId),
    listPlanningEventSnapshots(db),
    listPublishedPlanningEventSnapshots(db, clubId),
  ]);
  const requirements: PublicationRoleRequirements = {
    arbitre: settings.features.requireArbitreForPublication,
    encadrant: settings.features.requireEncadrantForPublication,
    accompagnateur: settings.features.requireAccompagnateurForPublication,
  };
  // Issue #72 (suite de #39) : les analytics du dashboard doivent refléter la même réalité
  // que « Mon planning » — le snapshot publié hydraté depuis le store opérationnel — et non
  // le brouillon de travail. Repli sur le live tant que le club n'a jamais publié.
  const source = publishedSnapshots
    ? await hydratePlanningAssignmentStates(db, publishedSnapshots, clubId)
    : snapshots;
  return computePlanningAnalytics(source, requirements, {
    periodDays: planningAnalyticsPeriodDays(),
    timeZone: settings.timeZone,
  });
}
