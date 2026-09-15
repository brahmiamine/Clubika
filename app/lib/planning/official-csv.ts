import { randomUUID } from 'node:crypto';
import { containsForbiddenSportCoricoMark } from '@/lib/privacy/sportcorico-data';
import type { Match } from '@/types/match';

export const OFFICIAL_CSV_COLUMNS = [
  'date',
  'time',
  'localTeam',
  'awayTeam',
  'venue',
  'competition',
  'categorie',
  'stadium',
  'address',
] as const;

const HEADER_ALIASES: Record<string, (typeof OFFICIAL_CSV_COLUMNS)[number]> = {
  date: 'date',
  time: 'time',
  heure: 'time',
  localteam: 'localTeam',
  equipelocale: 'localTeam',
  awayteam: 'awayTeam',
  equipeadverse: 'awayTeam',
  venue: 'venue',
  lieu: 'venue',
  competition: 'competition',
  categorie: 'categorie',
  category: 'categorie',
  stadium: 'stadium',
  stade: 'stadium',
  address: 'address',
  adresse: 'address',
};

const REQUIRED = ['date', 'time', 'localTeam', 'awayTeam', 'venue'] as const;

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i += 1;
        continue;
      }
      if (char === '"') {
        inQuotes = false;
        continue;
      }
      field += char;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      current.push(field.trim());
      field = '';
      continue;
    }
    if (char === '\n') {
      current.push(field.trim());
      if (current.some((cell) => cell.length > 0)) rows.push(current);
      current = [];
      field = '';
      continue;
    }
    if (char === '\r') continue;
    field += char;
  }
  current.push(field.trim());
  if (current.some((cell) => cell.length > 0)) rows.push(current);
  return rows;
}

function mapVenue(value: string): 'domicile' | 'extérieur' | null {
  const normalized = value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (normalized === 'domicile' || normalized === 'home') return 'domicile';
  if (normalized === 'exterieur' || normalized === 'away') return 'extérieur';
  return null;
}

export type OfficialCsvParseResult =
  | { ok: true; matches: Match[] }
  | { ok: false; error: string };

export function parseOfficialMatchesCsv(csvText: string, importedByUserId?: number): OfficialCsvParseResult {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) {
    return { ok: false, error: 'Le fichier CSV ne contient aucune ligne de données.' };
  }
  const headerRow = rows[0];
  if (!headerRow) {
    return { ok: false, error: 'Le fichier CSV ne contient aucune ligne de données.' };
  }
  const header = headerRow.map((cell) => HEADER_ALIASES[normalizeHeader(cell)]);
  if (header.some((col) => !col)) {
    return {
      ok: false,
      error: `Colonnes attendues : ${OFFICIAL_CSV_COLUMNS.join(', ')}.`,
    };
  }
  const importedAt = new Date().toISOString();
  const matches: Match[] = [];
  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    const cells = rows[i];
    const record: Partial<Record<(typeof OFFICIAL_CSV_COLUMNS)[number], string>> = {};
    for (let c = 0; c < header.length; c++) {
      const key = header[c];
      if (!key) continue;
      record[key] = (cells ?? [])[c] ?? '';
    }
    for (const key of REQUIRED) {
      if (!record[key]) {
        return { ok: false, error: `Ligne ${line} : la colonne « ${key} » est obligatoire.` };
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if (containsForbiddenSportCoricoMark(value)) {
        return { ok: false, error: `Ligne ${line} : la colonne « ${key} » contient une mention SportCorico interdite.` };
      }
    }
    const venue = mapVenue(record.venue ?? '');
    if (!venue) {
      return { ok: false, error: `Ligne ${line} : venue doit être « domicile » ou « extérieur ».` };
    }
    const id = `officiel-csv-${randomUUID()}`;
    const competition = record.competition || 'Match officiel';
    const stadium = record.stadium || '';
    const address = record.address || '';
    matches.push({
      id,
      type: 'officiel',
      date: record.date as string,
      time: record.time as string,
      durationMinutes: 90,
      competition,
      categorie: record.categorie || undefined,
      localTeam: record.localTeam as string,
      awayTeam: record.awayTeam as string,
      venue,
      horaireRendezVous: record.time as string,
      sourceMatchId: `csv:${id}`,
      sourceStatus: 'active',
      details: stadium || address
        ? {
            stadium,
            dateTime: `${record.date} - ${record.time}`,
            competition,
            address,
            terrainType: '',
            itineraryLink: '',
            rawText: '',
          }
        : null,
      importProvenance: {
        provider: 'csv',
        providerId: id,
        importedAt,
        importedByUserId,
        rightsAttested: true,
      },
    });
  }
  return { ok: true, matches };
}
