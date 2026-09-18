import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PlanningEventSnapshot } from './event-store';
import {
  DEFAULT_PUBLIC_SHARE_MAX_EXPIRY_DAYS,
  FORBIDDEN_PUBLIC_PLANNING_KEYS,
  PUBLIC_PLANNING_ITEM_KEYS,
  PUBLIC_SHARE_MAX_EXPIRY_DAYS_ENV_KEY,
  clampShareExpiryDays,
  hashShareToken,
  publicShareMaxExpiryDays,
  publicSportsVenueAddress,
  toPublicPlanningItem,
} from './public-share';

const snapshot: PlanningEventSnapshot = {
  eventId: 'match-42',
  eventType: 'officiel',
  title: 'AFP – Visiteur avec Dupont',
  date: '23/08/2026',
  time: '15:00',
  durationMinutes: 90,
  location: '12 rue privée Dupont',
  planningStatus: 'published',
  event: {
    id: 'match-42',
    type: 'officiel',
    date: '23/08/2026',
    time: '15:00',
    horaireRendezVous: '14:00',
    competition: 'Championnat',
    categorie: 'U15',
    localTeam: 'AFP',
    awayTeam: 'Visiteur',
    venue: 'domicile',
    details: {
      stadium: 'Stade AFP',
      dateTime: '',
      competition: 'Championnat',
      address: '1 avenue du Stade, Paris',
      terrainType: '',
      itineraryLink: '',
      rawText: '',
    },
    staff: {
      referee: 'Nom Privé',
      assistant1: 'Assistant Privé',
      assistant2: '',
      rawText: '',
    },
  },
  extras: { id: 'match-42', planningStatus: 'published' },
  assignments: {
    arbitre: [{ nom: 'Nom Privé', numero: '0612345678', personId: 7, personType: 'officiel', status: 'accepted' }],
    encadrant: [],
    accompagnateur: [],
  },
};

describe('public planning shares', () => {
  it('hashes raw share tokens without retaining the original value', () => {
    const raw = 'secret-public-share-token';
    const hash = hashShareToken(raw);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(raw);
    expect(hashShareToken(raw)).toBe(hash);
  });

  it('expose uniquement la liste blanche calendrier, sans identité (issue #6)', () => {
    const item = toPublicPlanningItem(snapshot);
    const serialized = JSON.stringify(item);

    expect(Object.keys(item).sort()).toEqual([...PUBLIC_PLANNING_ITEM_KEYS.filter((key) => key !== 'weather')].sort());
    expect(item).toEqual(expect.objectContaining({
      eventType: 'officiel',
      title: 'AFP – Visiteur',
      date: '23/08/2026',
      time: '15:00',
      endTime: '16:30',
      competition: 'Championnat',
      homeTeam: 'AFP',
      awayTeam: 'Visiteur',
      venue: 'domicile',
      stadium: 'Stade AFP',
      address: '1 avenue du Stade, Paris',
    }));

    for (const key of FORBIDDEN_PUBLIC_PLANNING_KEYS) {
      expect(item).not.toHaveProperty(key);
    }
    expect(serialized).not.toContain('Nom Privé');
    expect(serialized).not.toContain('Assistant Privé');
    expect(serialized).not.toContain('0612345678');
    expect(serialized).not.toContain('personId');
    expect(serialized).not.toContain('14:00');
    expect(serialized).not.toContain('Dupont');
    expect(serialized).not.toContain('12 rue privée');
  });

  it('n’utilise pas le titre libre du snapshot comme libellé public', () => {
    const item = toPublicPlanningItem({
      ...snapshot,
      eventType: 'entrainement',
      title: 'Entraînement avec Marie Dupont',
      event: {
        id: 'tr-1',
        type: 'entrainement',
        date: '23/08/2026',
        time: '15:00',
        categorie: 'U15',
      } as PlanningEventSnapshot['event'],
      assignments: {
        encadrant: [{ nom: 'Marie Dupont', numero: '0600000000', personId: 9, personType: 'encadrant' }],
      } as PlanningEventSnapshot['assignments'],
    });

    expect(item.title).toBe('Entraînement · U15');
    expect(JSON.stringify(item)).not.toContain('Marie Dupont');
    expect(item.stadium).toBeNull();
    expect(item.address).toBeNull();
  });
});

describe('durée maximale des liens de partage public (issue #14)', () => {
  it('propose 30 jours par défaut, réduit depuis 90', () => {
    expect(DEFAULT_PUBLIC_SHARE_MAX_EXPIRY_DAYS).toBe(30);
    expect(publicShareMaxExpiryDays({})).toBe(30);
  });

  it('reste configurable par variable d’environnement, plafonnée à l’ancien maximum (90 j)', () => {
    expect(publicShareMaxExpiryDays({ [PUBLIC_SHARE_MAX_EXPIRY_DAYS_ENV_KEY]: '14' })).toBe(14);
    expect(publicShareMaxExpiryDays({ [PUBLIC_SHARE_MAX_EXPIRY_DAYS_ENV_KEY]: '9000' })).toBe(90);
    expect(publicShareMaxExpiryDays({ [PUBLIC_SHARE_MAX_EXPIRY_DAYS_ENV_KEY]: '0' })).toBe(30);
    expect(publicShareMaxExpiryDays({ [PUBLIC_SHARE_MAX_EXPIRY_DAYS_ENV_KEY]: '-5' })).toBe(30);
    expect(publicShareMaxExpiryDays({ [PUBLIC_SHARE_MAX_EXPIRY_DAYS_ENV_KEY]: 'nope' })).toBe(30);
  });

  it.each([
    // [libellé, valeur brute, résultat attendu]
    ['0', 0, 1],
    ['une valeur négative', -5, 1],
    ['une valeur non numérique', 'nope', 7],
    ['une valeur non numérique (NaN direct)', Number.NaN, 7],
    ['absente (undefined)', undefined, 7],
    ['30 jours (limite)', 30, 30],
    ['plus de 30 jours', 45, 30],
    ['largement plus de 30 jours', 365, 30],
    ['1 jour (minimum)', 1, 1],
  ])('clampe une durée « %s » (%s) vers %i jour(s)', (_label, raw, expected) => {
    expect(clampShareExpiryDays(raw, 30)).toBe(expected);
  });

  it('utilise le maximum configuré par défaut quand aucun plafond explicite n’est fourni', () => {
    expect(clampShareExpiryDays(45)).toBe(publicShareMaxExpiryDays());
  });
});

describe('publicSportsVenueAddress', () => {
  it('refuse une adresse sans stade officiel ou sans indice d’enceinte sportive', () => {
    expect(publicSportsVenueAddress(null, '1 rue du Stade')).toBeNull();
    expect(publicSportsVenueAddress('Salle municipale', null)).toBeNull();
    expect(publicSportsVenueAddress('Domicile de l’entraîneur', '12 rue des Lilas')).toBeNull();
  });

  it('conserve l’adresse d’un stade nommé', () => {
    expect(publicSportsVenueAddress('Stade AFP', '1 avenue du Stade, Paris')).toBe('1 avenue du Stade, Paris');
  });
});

describe('surfaces publiques (issue #6)', () => {
  it('ne transporte plus officials/referee dans le DTO ni la page', () => {
    const page = readFileSync(new URL('../../partage/[token]/page.tsx', import.meta.url), 'utf8');
    const route = readFileSync(new URL('../../api/public/planning/[token]/route.ts', import.meta.url), 'utf8');
    expect(page).not.toMatch(/\bofficials\b/);
    expect(page).not.toMatch(/\breferee\b/);
    expect(page).not.toMatch(/\bassistants\b/);
    expect(route).not.toContain('id: share.clubId');
  });
});
