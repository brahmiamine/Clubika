/**
 * Snapshot des schémas publics allowlistés (issue #41).
 *
 * `boundaries.test.ts` vérifie déjà que le DTO public ne dépasse jamais
 * `PUBLIC_CLUB_SETTINGS_KEYS` / `PUBLIC_PLANNING_ITEM_KEYS`, mais il importe ces
 * allowlists depuis leur module source : si quelqu'un y ajoute un champ, ce test
 * l'accepterait silencieusement puisque l'assertion se ferait contre la même
 * valeur mise à jour.
 *
 * Ce fichier compare au contraire chaque allowlist source à une copie **figée et
 * recopiée à la main** ci-dessous, indépendante du module qui la définit. Ajouter
 * un champ à une frontière publique fait donc obligatoirement échouer CE test tant
 * que la copie figée n'est pas éditée dans le même commit — ce qui, en pratique,
 * force la revue privacy explicite demandée par l'issue #41 (le diff de PR montre
 * alors noir sur blanc « + un champ ajouté à une frontière publique »).
 *
 * Ne JAMAIS faire évoluer ce fichier en réimportant l'allowlist source : recopier
 * la nouvelle liste à la main, volontairement, après revue.
 */
import { describe, expect, it } from 'vitest';
import { PUBLIC_CLUB_SETTINGS_KEYS, FORBIDDEN_PUBLIC_SETTINGS_KEYS } from '@/lib/settings-public';
import { PUBLIC_PLANNING_ITEM_KEYS, FORBIDDEN_PUBLIC_PLANNING_KEYS } from '@/lib/planning/public-share';

// Copie figée de PUBLIC_CLUB_SETTINGS_KEYS (issue #21) au moment de l'écriture de
// cette suite. Doit être mise à jour à la main, avec revue privacy, si la source évolue.
const FROZEN_PUBLIC_CLUB_SETTINGS_KEYS = [
  'clubName',
  'primaryColor',
  'accentColor',
  'clubLogo',
] as const;

// Copie figée de FORBIDDEN_PUBLIC_SETTINGS_KEYS (mêmes règles).
const FROZEN_FORBIDDEN_PUBLIC_SETTINGS_KEYS = [
  'smtp',
  'host',
  'port',
  'secure',
  'user',
  'password',
  'passwordSet',
  'fromEmail',
  'fromName',
  'features',
  'themeMode',
  'timeZone',
  'matchesUrlKey',
  'scraperClubName',
  'clubAbbreviation',
  'clubDescription',
  'travelAndWeather',
  'volunteerShifts',
  'whatsapp',
  'assignmentValidation',
  'publicationReadiness',
  'scraperSync',
  'eventChat',
] as const;

// Copie figée de PUBLIC_PLANNING_ITEM_KEYS (issue #6).
const FROZEN_PUBLIC_PLANNING_ITEM_KEYS = [
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

// Copie figée de FORBIDDEN_PUBLIC_PLANNING_KEYS.
const FROZEN_FORBIDDEN_PUBLIC_PLANNING_KEYS = [
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

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

describe('snapshot des schémas publics allowlistés (issue #41)', () => {
  it('paramètres publics de club : aucun champ ajouté sans revue privacy explicite', () => {
    expect(
      sorted(PUBLIC_CLUB_SETTINGS_KEYS),
      'PUBLIC_CLUB_SETTINGS_KEYS a changé : mets à jour FROZEN_PUBLIC_CLUB_SETTINGS_KEYS dans ce fichier après revue privacy explicite (finalité, durée, destinataires, droits).',
    ).toEqual(sorted(FROZEN_PUBLIC_CLUB_SETTINGS_KEYS));
    expect(sorted(FORBIDDEN_PUBLIC_SETTINGS_KEYS)).toEqual(sorted(FROZEN_FORBIDDEN_PUBLIC_SETTINGS_KEYS));
  });

  it('éléments de planning publics : aucun champ ajouté sans revue privacy explicite', () => {
    expect(
      sorted(PUBLIC_PLANNING_ITEM_KEYS),
      'PUBLIC_PLANNING_ITEM_KEYS a changé : mets à jour FROZEN_PUBLIC_PLANNING_ITEM_KEYS dans ce fichier après revue privacy explicite.',
    ).toEqual(sorted(FROZEN_PUBLIC_PLANNING_ITEM_KEYS));
    expect(sorted(FORBIDDEN_PUBLIC_PLANNING_KEYS)).toEqual(sorted(FROZEN_FORBIDDEN_PUBLIC_PLANNING_KEYS));
  });
});
