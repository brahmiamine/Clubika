import { describe, expect, it } from 'vitest';
import { parseOfficialMatchesCsv } from './official-csv';

const HEADER = 'date,time,localTeam,awayTeam,venue,competition,categorie,stadium,address';

describe('parseOfficialMatchesCsv', () => {
  it('importe un calendrier sans URL tierce', () => {
    const csv = `${HEADER}\n01/09/2026,15:00,Equipe A,Equipe B,domicile,Championnat,Seniors,Stade,1 rue`;
    const result = parseOfficialMatchesCsv(csv, 42);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.matches).toHaveLength(1);
    const first = result.matches[0]!;
    expect(first.localTeam).toBe('Equipe A');
    expect(first.venue).toBe('domicile');
    expect(first.importProvenance?.provider).toBe('csv');
    expect(first.importProvenance?.rightsAttested).toBe(true);
    expect(first.url).toBeUndefined();
    expect(first.sourceMatchId).toMatch(/^csv:/);
  });

  it('refuse une URL SportCorico', () => {
    const csv = `${HEADER}\n01/09/2026,15:00,Equipe A,Equipe B,domicile,https://www.sportcorico.com/x,,,`;
    const result = parseOfficialMatchesCsv(csv);
    expect(result.ok).toBe(false);
  });

  it('exige les colonnes obligatoires', () => {
    const csv = `${HEADER}\n01/09/2026,15:00,,Equipe B,domicile,,,,`;
    const result = parseOfficialMatchesCsv(csv);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/localTeam/);
  });

  it('accepte les en-têtes français et le lieu Extérieur', () => {
    const csv = 'date,heure,equipeLocale,equipeAdverse,lieu\n02/09/2026,10:00,A,B,Extérieur';
    const result = parseOfficialMatchesCsv(csv);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const imported = result.matches[0]!;
    expect(imported.venue).toBe('extérieur');
    expect(imported.competition).toBe('Match officiel');
  });
});
