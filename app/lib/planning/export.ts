import type { AssignmentContact, Entrainement, Match, Plateau } from '@/types/match';
import { assignmentStatus } from '@/lib/planning/p0-rules';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';
import { eventCategory } from '@/lib/planning/public-share';

export const EXPORT_COLUMN_IDS = [
  'date',
  'time',
  'type',
  'category',
  'competition',
  'localTeam',
  'awayTeam',
  'venue',
  'location',
  'stadium',
  'address',
  'terrainType',
  'meetingTime',
  'referee',
  'assistant1',
  'assistant2',
  'arbitreTouche',
  'encadrants',
  'contactEncadrants',
  'contactAccompagnateur',
  'confirmed',
] as const;

export type ExportColumnId = (typeof EXPORT_COLUMN_IDS)[number];

export type ExportColumnKind = 'operational' | 'identity';

export interface ExportColumnDefinition {
  id: ExportColumnId;
  label: string;
  kind: ExportColumnKind;
  defaultEnabled: boolean;
}

export const EXPORT_COLUMNS: readonly ExportColumnDefinition[] = [
  { id: 'date', label: 'Date', kind: 'operational', defaultEnabled: true },
  { id: 'time', label: 'Heure', kind: 'operational', defaultEnabled: true },
  { id: 'type', label: 'Type', kind: 'operational', defaultEnabled: true },
  { id: 'category', label: 'Catégorie', kind: 'operational', defaultEnabled: true },
  { id: 'competition', label: 'Compétition', kind: 'operational', defaultEnabled: true },
  { id: 'localTeam', label: 'Équipe locale', kind: 'operational', defaultEnabled: true },
  { id: 'awayTeam', label: 'Équipe visiteuse', kind: 'operational', defaultEnabled: true },
  { id: 'venue', label: 'Lieu (domicile/extérieur)', kind: 'operational', defaultEnabled: true },
  { id: 'location', label: 'Lieu', kind: 'operational', defaultEnabled: true },
  { id: 'stadium', label: 'Stade', kind: 'operational', defaultEnabled: false },
  { id: 'address', label: 'Adresse', kind: 'operational', defaultEnabled: false },
  { id: 'terrainType', label: 'Type de terrain', kind: 'operational', defaultEnabled: false },
  { id: 'meetingTime', label: 'Horaire de rendez-vous', kind: 'operational', defaultEnabled: false },
  { id: 'referee', label: 'Arbitre officiel', kind: 'identity', defaultEnabled: false },
  { id: 'assistant1', label: 'Assistant 1', kind: 'identity', defaultEnabled: false },
  { id: 'assistant2', label: 'Assistant 2', kind: 'identity', defaultEnabled: false },
  { id: 'arbitreTouche', label: 'Arbitre', kind: 'identity', defaultEnabled: false },
  { id: 'encadrants', label: 'Encadrants', kind: 'identity', defaultEnabled: false },
  { id: 'contactEncadrants', label: 'Contact encadrants', kind: 'identity', defaultEnabled: false },
  { id: 'contactAccompagnateur', label: 'Accompagnateur', kind: 'identity', defaultEnabled: false },
  { id: 'confirmed', label: 'Statut confirmé', kind: 'identity', defaultEnabled: false },
];

export const DEFAULT_EXPORT_COLUMN_IDS = EXPORT_COLUMNS
  .filter((column) => column.defaultEnabled)
  .map((column) => column.id);

const COLUMN_BY_ID = new Map(EXPORT_COLUMNS.map((column) => [column.id, column]));

const BANNED_COLUMN_IDS = /^(rawtext|secret|token|password|email|phone|report|chat|comment|audit|payload|body|health|last_error|decline)/i;

const TYPE_LABELS: Record<string, string> = {
  officiel: 'Officiel',
  amical: 'Amical',
  entrainement: 'Entraînement',
  plateau: 'Plateau',
};

const FORMULA_LEAD = /[\s\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]*/;
const FORMULA_START = /^[=+\-@\t\r\n\uFF1D\uFF0B\uFF0D\uFF20\uFE63\u2212\u2795]/;

export function csvCell(value: unknown): string {
  let text = String(value ?? '').replace(/\r\n|\r|\n/g, ' / ');
  const trimmedLead = text.replace(new RegExp(`^${FORMULA_LEAD.source}`), '');
  if (FORMULA_START.test(trimmedLead) || FORMULA_START.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

export function isExportColumnId(value: string): value is ExportColumnId {
  return COLUMN_BY_ID.has(value as ExportColumnId);
}

export function columnDefinition(id: ExportColumnId): ExportColumnDefinition {
  const column = COLUMN_BY_ID.get(id);
  if (!column) throw new Error(`Unknown export column: ${id}`);
  return column;
}

export class ExportColumnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportColumnError';
  }
}

export interface ResolvedExportColumns {
  ids: ExportColumnId[];
  includeIdentities: boolean;
  includePhones: boolean;
  purpose: string | null;
}

export function resolveExportColumns(input: {
  columns?: unknown;
  includeIdentities?: unknown;
  includePhones?: unknown;
  purpose?: unknown;
}): ResolvedExportColumns {
  const includeIdentities = input.includeIdentities === true || input.includeIdentities === '1';
  const includePhones = input.includePhones === true || input.includePhones === '1';
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim().slice(0, 200) : '';

  const requested = normalizeRequestedColumns(input.columns);
  for (const id of requested) {
    if (BANNED_COLUMN_IDS.test(id) || !isExportColumnId(id)) {
      throw new ExportColumnError('Colonne d’export non autorisée');
    }
  }

  const ids = requested.filter((id) => {
    const kind = columnDefinition(id).kind;
    return kind === 'operational' || includeIdentities;
  });

  if (requested.some((id) => columnDefinition(id).kind === 'identity') && !includeIdentities) {
    throw new ExportColumnError('Les identités nécessitent une action explicite et une finalité');
  }
  if (includePhones && !includeIdentities) {
    throw new ExportColumnError('Les téléphones nécessitent l’export d’identités');
  }
  if ((includeIdentities || includePhones) && purpose.length < 8) {
    throw new ExportColumnError('Indiquez une finalité d’au moins 8 caractères pour exporter des identités');
  }

  return {
    ids: ids.length ? ids : [...DEFAULT_EXPORT_COLUMN_IDS],
    includeIdentities,
    includePhones: includeIdentities && includePhones,
    purpose: purpose || null,
  };
}

function normalizeRequestedColumns(value: unknown): ExportColumnId[] {
  if (value == null || value === '') return [...DEFAULT_EXPORT_COLUMN_IDS];
  const raw = Array.isArray(value)
    ? value.map((item) => String(item))
    : String(value).split(',');
  const ids = [...new Set(raw.map((item) => item.trim()).filter(Boolean))];
  if (!ids.length) return [...DEFAULT_EXPORT_COLUMN_IDS];
  return ids as ExportColumnId[];
}

function formatContacts(contacts: AssignmentContact[], includePhones: boolean): string {
  return contacts
    .filter((contact) => assignmentStatus(contact) !== 'declined')
    .map((contact) => {
      const name = contact.nom?.trim() ?? '';
      const phone = includePhones ? contact.numero?.trim() : '';
      if (!name) return phone;
      return phone ? `${name} (${phone})` : name;
    })
    .filter(Boolean)
    .join(' / ');
}

function asMatch(snapshot: PlanningEventSnapshot): Match | null {
  return snapshot.eventType === 'officiel' || snapshot.eventType === 'amical'
    ? snapshot.event as Match
    : null;
}

function asSimple(snapshot: PlanningEventSnapshot): Entrainement | Plateau | null {
  return snapshot.eventType === 'entrainement' || snapshot.eventType === 'plateau'
    ? snapshot.event as Entrainement | Plateau
    : null;
}

export function projectExportValue(
  snapshot: PlanningEventSnapshot,
  column: ExportColumnId,
  includePhones: boolean,
): string {
  const match = asMatch(snapshot);
  const simple = asSimple(snapshot);
  switch (column) {
    case 'date':
      return snapshot.date;
    case 'time':
      return snapshot.time;
    case 'type':
      return TYPE_LABELS[snapshot.eventType] ?? snapshot.eventType;
    case 'category':
      return eventCategory(snapshot) ?? '';
    case 'competition':
      return match?.competition ?? '';
    case 'localTeam':
      return match?.localTeam ?? simple?.lieu ?? '';
    case 'awayTeam':
      return match?.awayTeam ?? '';
    case 'venue':
      return match?.venue === 'domicile' ? 'Domicile' : match?.venue === 'extérieur' ? 'Extérieur' : '';
    case 'location':
      return snapshot.location ?? simple?.lieu ?? '';
    case 'stadium':
      return match?.details?.stadium ?? '';
    case 'address':
      return match?.details?.address ?? '';
    case 'terrainType':
      return match?.details?.terrainType ?? '';
    case 'meetingTime':
      return match?.horaireRendezVous ?? '';
    case 'referee':
      return match?.staff?.referee ?? '';
    case 'assistant1':
      return match?.staff?.assistant1 ?? '';
    case 'assistant2':
      return match?.staff?.assistant2 ?? '';
    case 'arbitreTouche':
      return formatContacts(snapshot.assignments.arbitre, includePhones);
    case 'encadrants':
      return formatContacts(
        snapshot.assignments.encadrant.length ? snapshot.assignments.encadrant : (simple?.encadrants ?? []),
        includePhones,
      );
    case 'contactEncadrants':
      return formatContacts(snapshot.assignments.encadrant, includePhones);
    case 'contactAccompagnateur':
      return formatContacts(snapshot.assignments.accompagnateur, includePhones);
    case 'confirmed':
      return snapshot.extras && typeof snapshot.extras.confirmed === 'boolean'
        ? (snapshot.extras.confirmed ? 'Oui' : 'Non')
        : '';
    default:
      return '';
  }
}

export function projectExportRow(
  snapshot: PlanningEventSnapshot,
  columns: readonly ExportColumnId[],
  includePhones: boolean,
): Record<string, string> {
  const row: Record<string, string> = {};
  for (const column of columns) {
    row[column] = projectExportValue(snapshot, column, includePhones);
  }
  return row;
}

export function serializeExportCsv(
  columns: readonly ExportColumnId[],
  rows: Array<Record<string, string>>,
  labels: Record<string, string>,
): string {
  const header = columns.map((id) => csvCell(labels[id] ?? columnDefinition(id).label)).join(',');
  const body = rows.map((row) => columns.map((id) => csvCell(row[id] ?? '')).join(',')).join('\r\n');
  return `\uFEFF${header}\r\n${body}`;
}

export function exportFileName(format: 'csv' | 'json' | 'html'): string {
  return `planning-export.${format}`;
}

export const EXPORT_CACHE_HEADERS = {
  'Cache-Control': 'private, no-store',
  Pragma: 'no-store',
} as const;

const ROLE_LABEL_BASES: Partial<Record<ExportColumnId, string>> = {
  arbitreTouche: 'Arbitre',
  encadrants: 'Encadrants',
  contactAccompagnateur: 'Accompagnateur',
};

export function exportColumnLabels(
  clubAbbreviation: string,
  roleLabel: (base: string, abbreviation: string) => string,
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const column of EXPORT_COLUMNS) {
    const base = ROLE_LABEL_BASES[column.id];
    labels[column.id] = base ? roleLabel(base, clubAbbreviation) : column.label;
  }
  return labels;
}

