import { describe, expect, it } from 'vitest';
import {
  canEdit,
  hasAnyPlanningFunction,
  hasPlanningFunction,
  homePathForAccessRole,
  normalizeAccessRole,
  normalizePlanningFunctions,
} from './roles';

describe('rôle d’accès au club (issue #209)', () => {
  it('réserve l’écriture à l’administrateur', () => {
    expect(canEdit('admin')).toBe(true);
    expect(canEdit('dirigeant')).toBe(false);
    expect(canEdit(null)).toBe(false);
    expect(canEdit(undefined)).toBe(false);
  });

  it('envoie l’administrateur vers /club et le dirigeant vers /mon-planning', () => {
    expect(homePathForAccessRole('admin')).toBe('/club');
    expect(homePathForAccessRole('dirigeant')).toBe('/mon-planning');
    expect(homePathForAccessRole(null)).toBe('/mon-planning');
  });

  it('rabat toute valeur non administrateur sur dirigeant', () => {
    expect(normalizeAccessRole('admin')).toBe('admin');
    expect(normalizeAccessRole('dirigeant')).toBe('dirigeant');
    expect(normalizeAccessRole('arbitre')).toBe('dirigeant');
    expect(normalizeAccessRole(undefined)).toBe('dirigeant');
  });
});

describe('fonctions opérationnelles (issue #209)', () => {
  it('accepte le cumul des trois fonctions sur un seul compte', () => {
    const functions = normalizePlanningFunctions(['accompagnateur', 'arbitre_club', 'encadrant']);
    expect(functions).toEqual(['arbitre_club', 'encadrant', 'accompagnateur']);
    expect(hasPlanningFunction(functions, 'arbitre_club')).toBe(true);
    expect(hasPlanningFunction(functions, 'encadrant')).toBe(true);
    expect(hasPlanningFunction(functions, 'accompagnateur')).toBe(true);
  });

  it('ignore les valeurs inconnues et les doublons', () => {
    expect(normalizePlanningFunctions(['encadrant', 'encadrant', 'admin', 'arbitre'])).toEqual(['encadrant']);
    expect(normalizePlanningFunctions(null)).toEqual([]);
    expect(normalizePlanningFunctions('encadrant')).toEqual(['encadrant']);
  });

  it('n’accorde jamais de droit d’administration', () => {
    const functions = normalizePlanningFunctions(['arbitre_club', 'encadrant', 'accompagnateur']);
    expect(canEdit(normalizeAccessRole('dirigeant'))).toBe(false);
    expect(hasAnyPlanningFunction(functions)).toBe(true);
  });

  it('distingue un administrateur avec et sans fonction terrain', () => {
    expect(hasAnyPlanningFunction(normalizePlanningFunctions(['encadrant']))).toBe(true);
    expect(hasAnyPlanningFunction([])).toBe(false);
    expect(hasAnyPlanningFunction(null)).toBe(false);
  });
});
