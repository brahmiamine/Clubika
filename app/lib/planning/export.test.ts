import { describe, expect, it } from 'vitest';
import {
  csvCell,
  DEFAULT_EXPORT_COLUMN_IDS,
  ExportColumnError,
  projectExportRow,
  resolveExportColumns,
  serializeExportCsv,
} from './export';
import type { PlanningEventSnapshot } from './event-store';

const SENTINEL_PHONE = '+33600000000';
const SENTINEL_NAME = 'Sentinel Person';
const SENTINEL_RAW = 'rawText-should-never-export';
const SENTINEL_TOKEN = 'export-secret-token-value';
const SENTINEL_COMMENT = 'refus pour motif personnel';

function snapshot(): PlanningEventSnapshot {
  return {
    eventId: 'evt-1',
    eventType: 'officiel',
    title: 'AFP – Visiteur',
    date: '15/09/2026',
    time: '18:00',
    durationMinutes: 90,
    location: 'Stade A',
    planningStatus: 'published',
    event: {
      id: 'evt-1',
      type: 'officiel',
      date: '15/09/2026',
      time: '18:00',
      localTeam: 'AFP',
      awayTeam: 'Visiteur',
      venue: 'domicile',
      competition: 'Championnat',
      categorie: 'U13',
      horaireRendezVous: '17:15',
      details: {
        stadium: 'Stade A',
        dateTime: '',
        competition: 'Championnat',
        address: '1 rue du Stade',
        terrainType: 'Synthétique',
        itineraryLink: '',
        rawText: SENTINEL_RAW,
      },
      staff: {
        referee: SENTINEL_NAME,
        assistant1: '',
        assistant2: '',
        rawText: SENTINEL_RAW,
      },
    },
    extras: {
      id: 'evt-1',
      confirmed: true,
      arbitreTouche: [{
        nom: SENTINEL_NAME,
        numero: SENTINEL_PHONE,
        status: 'accepted',
        declineComment: SENTINEL_COMMENT,
        declineReason: 'personal',
      }],
    },
    assignments: {
      arbitre: [{ nom: SENTINEL_NAME, numero: SENTINEL_PHONE, status: 'accepted', declineComment: SENTINEL_COMMENT }],
      encadrant: [],
      accompagnateur: [],
    },
    revision: 1,
  } as PlanningEventSnapshot;
}

describe('csvCell (issue #33)', () => {
  it('neutralizes spreadsheet formulas including unicode prefixes', () => {
    expect(csvCell('=HYPERLINK("https://evil.example")')).toBe('"\'=HYPERLINK(""https://evil.example"")"');
    expect(csvCell('+1+1')).toBe('"\'+1+1"');
    expect(csvCell('-2+3')).toBe('"\'-2+3"');
    expect(csvCell('@SUM(A1:A2)')).toBe('"\'@SUM(A1:A2)"');
    expect(csvCell('\t=cmd')).toContain("'");
    expect(csvCell('\uFF1D1+1')).toContain("'");
    expect(csvCell('AFP, Paris')).toBe('"AFP, Paris"');
  });
});

describe('resolveExportColumns (issue #33)', () => {
  it('defaults to operational columns without identities', () => {
    const resolved = resolveExportColumns({});
    expect(resolved.ids).toEqual(DEFAULT_EXPORT_COLUMN_IDS);
    expect(resolved.includeIdentities).toBe(false);
    expect(resolved.includePhones).toBe(false);
  });

  it('rejects banned keys and identities without purpose', () => {
    expect(() => resolveExportColumns({ columns: ['rawText'] })).toThrow(ExportColumnError);
    expect(() => resolveExportColumns({ columns: ['token'] })).toThrow(ExportColumnError);
    expect(() => resolveExportColumns({ columns: ['arbitreTouche'] })).toThrow(/identités/);
    expect(() => resolveExportColumns({
      columns: ['arbitreTouche'],
      includeIdentities: true,
    })).toThrow(/finalité/);
  });

  it('keeps identity columns only with explicit purpose', () => {
    const resolved = resolveExportColumns({
      columns: ['date', 'arbitreTouche'],
      includeIdentities: true,
      includePhones: true,
      purpose: 'convocation week-end U13',
    });
    expect(resolved.ids).toEqual(['date', 'arbitreTouche']);
    expect(resolved.includePhones).toBe(true);
  });
});

describe('projectExportRow (issue #33)', () => {
  it('omits names, phones, comments and rawText by default', () => {
    const row = projectExportRow(snapshot(), DEFAULT_EXPORT_COLUMN_IDS, false);
    const dumped = JSON.stringify(row);
    expect(dumped).not.toContain(SENTINEL_NAME);
    expect(dumped).not.toContain(SENTINEL_PHONE);
    expect(dumped).not.toContain(SENTINEL_RAW);
    expect(dumped).not.toContain(SENTINEL_TOKEN);
    expect(dumped).not.toContain(SENTINEL_COMMENT);
    expect(row.date).toBe('15/09/2026');
    expect(row.localTeam).toBe('AFP');
    expect(row).not.toHaveProperty('arbitreTouche');
  });

  it('can include names without phones when identities are requested', () => {
    const row = projectExportRow(snapshot(), ['arbitreTouche'], false);
    expect(row.arbitreTouche).toBe(SENTINEL_NAME);
    expect(row.arbitreTouche).not.toContain(SENTINEL_PHONE);
  });
});

describe('serializeExportCsv (issue #33)', () => {
  it('quotes cells and does not embed a raw business object', () => {
    const csv = serializeExportCsv(['date'], [{ date: '=1+1' }], { date: 'Date' });
    expect(csv).toContain('"\'=1+1"');
    expect(csv).not.toContain('extras');
    expect(csv).not.toContain('rawText');
  });
});
