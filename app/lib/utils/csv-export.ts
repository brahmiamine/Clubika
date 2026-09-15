import { csvCell, exportFileName, type ExportColumnId } from '@/lib/planning/export';
import { triggerBlobDownload } from './planning-export-data';

export function generateCsvFromRows(
  columns: Array<{ id: string; label: string }>,
  rows: Array<Record<string, string>>,
): void {
  if (!columns.length || !rows.length) return;
  const header = columns.map((column) => csvCell(column.label)).join(',');
  const body = rows
    .map((row) => columns.map((column) => csvCell(row[column.id as ExportColumnId] ?? '')).join(','))
    .join('\r\n');
  const blob = new Blob([`\uFEFF${header}\r\n${body}`], { type: 'text/csv;charset=utf-8;' });
  triggerBlobDownload(blob, exportFileName('csv'));
}
