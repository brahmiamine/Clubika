/**
 * Deux notions orthogonales (issue #209) :
 *
 * - le **rôle d'accès au club** (`ClubAccessRole`) porte les permissions : un compte
 *   est soit `admin` (gestion complète du club, planning, comptes, configuration),
 *   soit `dirigeant` (espace personnel et fonctionnalités membres) ;
 * - les **fonctions opérationnelles** (`PlanningFunction`) sont cumulables et portent
 *   l'éligibilité aux affectations, les préférences métier et le ciblage des campagnes.
 *
 * Une fonction ne donne jamais de droit d'administration, et le rôle d'accès ne rend
 * jamais un compte affectable.
 */
export type ClubAccessRole = 'admin' | 'dirigeant';

export type PlanningFunction = 'arbitre_club' | 'encadrant' | 'accompagnateur';

export const ALL_ACCESS_ROLES: ClubAccessRole[] = ['admin', 'dirigeant'];

/** Rôles d'accès autorisés à écrire (planning, comptes, configuration). */
export const WRITE_ROLES: ClubAccessRole[] = ['admin'];

export const ALL_PLANNING_FUNCTIONS: PlanningFunction[] = ['arbitre_club', 'encadrant', 'accompagnateur'];

export const ACCESS_ROLE_LABELS: Record<ClubAccessRole, string> = {
  admin: 'Administrateur',
  dirigeant: 'Dirigeant',
};

export const PLANNING_FUNCTION_LABELS: Record<PlanningFunction, string> = {
  arbitre_club: 'Arbitre club',
  encadrant: 'Encadrant',
  accompagnateur: 'Accompagnateur',
};

export function isClubAccessRole(value: unknown): value is ClubAccessRole {
  return typeof value === 'string' && (ALL_ACCESS_ROLES as string[]).includes(value);
}

export function isPlanningFunction(value: unknown): value is PlanningFunction {
  return typeof value === 'string' && (ALL_PLANNING_FUNCTIONS as string[]).includes(value);
}

/** Rôle d'accès d'un compte ; tout ce qui n'est pas explicitement `admin` est dirigeant. */
export function normalizeAccessRole(value: unknown): ClubAccessRole {
  return value === 'admin' ? 'admin' : 'dirigeant';
}

/** Fonctions opérationnelles d'un compte, dédoublonnées et dans l'ordre du référentiel. */
export function normalizePlanningFunctions(value: unknown): PlanningFunction[] {
  const list = Array.isArray(value) ? value : [value];
  const held = new Set(list.filter(isPlanningFunction));
  return ALL_PLANNING_FUNCTIONS.filter((fn) => held.has(fn));
}

/** Seul l'administrateur du club modifie le planning, les comptes et la configuration. */
export function canEdit(accessRole: ClubAccessRole | null | undefined): boolean {
  return accessRole === 'admin';
}

/** Accueil après connexion (ou ouverture de la PWA) selon le rôle d'accès au club. */
export function homePathForAccessRole(accessRole: ClubAccessRole | null | undefined): '/club' | '/mon-planning' {
  return canEdit(accessRole) ? '/club' : '/mon-planning';
}

export function hasPlanningFunction(
  functions: PlanningFunction[] | null | undefined,
  planningFunction: PlanningFunction,
): boolean {
  return !!functions && functions.includes(planningFunction);
}

/** Vrai si le compte tient au moins une fonction terrain, quel que soit son rôle d'accès. */
export function hasAnyPlanningFunction(functions: PlanningFunction[] | null | undefined): boolean {
  return !!functions && functions.length > 0;
}
