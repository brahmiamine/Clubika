import { describe, expect, it } from 'vitest';
import {
  buildShareCardModel,
  collectShareCardFacts,
  matchTypeLabel,
  resolveShareCardPalette,
  venueLabel,
} from './share-match-card-theme';
import type { Match } from '@/types/match';

const match = {
  localTeam: 'A',
  awayTeam: 'B',
  date: '12/09/2026',
  time: '17:00',
  horaireRendezVous: '15:30',
  competition: 'Seniors',
  venue: 'extérieur',
  type: 'officiel',
  details: { stadium: 'Jean Bouin', address: 'Taverny', terrainType: 'Synthétique', dateTime: '', competition: '', itineraryLink: '', rawText: '' },
  staff: { referee: 'Samire', assistant1: '', assistant2: '', rawText: '' },
} as Match;

describe('share-match-card-theme', () => {
  it('construit une palette lisible à partir des couleurs club', () => {
    const palette = resolveShareCardPalette('#008509', '#e3ebf7');
    expect(palette.primary).toBe('#008509');
    expect(palette.secondary).toBe('#e3ebf7');
    expect(palette.onPrimary).toBe('#f8fafc');
    expect(palette.onSecondary).toBe('#111827');
  });

  it('priorise le lieu et les officiels du club', () => {
    const facts = collectShareCardFacts(match, {
      id: '1',
      arbitreTouche: [{ nom: 'Léa', numero: '' }],
      contactEncadrants: [{ nom: 'Marc', numero: '' }],
    }, 'SP');

    expect(facts[0]).toEqual({ label: 'Lieu', value: 'Jean Bouin\nTaverny' });
    expect(facts.some((fact) => fact.label === 'Terrain' && fact.value === 'Synthétique')).toBe(true);
    expect(facts.some((fact) => fact.label === 'Arbitre SP' && fact.value === 'Léa')).toBe(true);
    expect(facts).toHaveLength(3);
  });

  it('libellés de type et de venue', () => {
    expect(matchTypeLabel('officiel')).toBe('Officiel');
    expect(venueLabel('extérieur')).toBe('Extérieur');
  });

  it('assemble le modèle de carte avec compétition et horaire', () => {
    const card = buildShareCardModel({
      match,
      clubName: 'La Salesienne de Paris',
      clubAbbreviation: 'SP',
      primaryColor: '#008509',
      secondaryColor: '#e3ebf7',
    });

    expect(card.clubName).toBe('La Salesienne de Paris');
    expect(card.competition).toBe('Seniors');
    expect(card.time).toBe('17:00');
    expect(card.rendezVous).toBe('15:30');
    expect(card.venue).toBe('Extérieur');
    expect(card.palette.primary).toBe('#008509');
  });
});
