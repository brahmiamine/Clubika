import { NextResponse } from 'next/server';
import {
  EXPORT_CACHE_HEADERS,
  exportFileName,
  serializeExportCsv,
  columnDefinition,
  type ExportColumnId,
} from '@/lib/planning/export';
import type { ExportDownloadFormat } from '@/lib/planning/export-download';

function html(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderExportBody(input: {
  format: ExportDownloadFormat;
  columns: readonly ExportColumnId[];
  rows: Array<Record<string, string>>;
  labels: Record<string, string>;
  clubName: string;
}): { body: string; contentType: string; fileName: string } {
  const fileName = exportFileName(input.format);
  if (input.format === 'csv') {
    return {
      body: serializeExportCsv(input.columns, input.rows, input.labels),
      contentType: 'text/csv; charset=utf-8',
      fileName,
    };
  }
  if (input.format === 'json') {
    return {
      body: JSON.stringify({
        clubName: input.clubName,
        columns: input.columns.map((id) => ({ id, label: input.labels[id] ?? columnDefinition(id).label })),
        rows: input.rows,
      }),
      contentType: 'application/json; charset=utf-8',
      fileName,
    };
  }

  const header = input.columns.map((id) => `<th>${html(input.labels[id] ?? columnDefinition(id).label)}</th>`).join('');
  const tableRows = input.rows
    .map((row) => `<tr>${input.columns.map((id) => `<td>${html(row[id] ?? '')}</td>`).join('')}</tr>`)
    .join('');
  const document = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><title>Planning</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#111}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #bbb;padding:6px;text-align:left}th{background:#eee}@media print{button{display:none}}</style></head><body><button onclick="window.print()">Imprimer</button><h1>${html(input.clubName)}</h1><table><thead><tr>${header}</tr></thead><tbody>${tableRows}</tbody></table></body></html>`;
  return {
    body: document,
    contentType: 'text/html; charset=utf-8',
    fileName,
  };
}

export function exportFileResponse(rendered: { body: string; contentType: string; fileName: string }): NextResponse {
  return new NextResponse(rendered.body, {
    headers: {
      'Content-Type': rendered.contentType,
      'Content-Disposition': `attachment; filename="${rendered.fileName}"`,
      ...EXPORT_CACHE_HEADERS,
    },
  });
}
