import { apiPost } from './api';
import { ApiRequestError } from './api';

export interface PlanningExportRequest {
  format: 'csv' | 'json' | 'html';
  columns: string[];
  eventTypes: Array<'officiel' | 'amical' | 'entrainement' | 'plateau'>;
  includeDrafts: boolean;
  includeIdentities: boolean;
  includePhones: boolean;
  purpose?: string;
}

export interface PlanningExportTicket {
  token: string;
  expiresAt: string;
  rowCount: number;
  format: 'csv' | 'json' | 'html';
}

export interface PlanningExportJson {
  clubName: string;
  columns: Array<{ id: string; label: string }>;
  rows: Array<Record<string, string>>;
}

export async function createPlanningExport(input: PlanningExportRequest): Promise<PlanningExportTicket> {
  return apiPost<PlanningExportTicket>('/api/planning/export', input);
}

export async function downloadPlanningExport(token: string): Promise<Response> {
  const response = await fetch(`/api/planning/export/${encodeURIComponent(token)}`, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Cache-Control': 'no-store' },
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Téléchargement impossible' }));
    throw new ApiRequestError(
      typeof errorData.error === 'string' ? errorData.error : 'Téléchargement impossible',
      response.status,
    );
  }
  return response;
}

export async function fetchPlanningExportJson(input: Omit<PlanningExportRequest, 'format'>): Promise<PlanningExportJson> {
  const ticket = await createPlanningExport({ ...input, format: 'json' });
  const response = await downloadPlanningExport(ticket.token);
  return response.json() as Promise<PlanningExportJson>;
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
