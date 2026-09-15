import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import {
  planningRecordId,
  savePlanningRecord,
} from '@/lib/planning/records';
import type { PlanningEventType } from '@/lib/planning/event-store';
import type { ExportColumnId } from '@/lib/planning/export';
import { hashShareToken, newShareToken } from '@/lib/planning/public-share';

export const EXPORT_DOWNLOAD_TTL_MS = 2 * 60 * 1000;

export type ExportDownloadFormat = 'csv' | 'json' | 'html';

export interface ExportDownloadPayload {
  format: ExportDownloadFormat;
  columns: ExportColumnId[];
  eventTypes: PlanningEventType[];
  fromDate: string | null;
  toDate: string | null;
  includeDrafts: boolean;
  includeIdentities: boolean;
  includePhones: boolean;
  purpose: string | null;
  expiresAt: string;
  usedAt: string | null;
  rowCount: number;
}

export interface ExportAuditPayload {
  actor: string;
  at: string;
  format: ExportDownloadFormat;
  columns: ExportColumnId[];
  purpose: string | null;
  rowCount: number;
  includeIdentities: boolean;
  includePhones: boolean;
}

export function newExportDownloadToken(): string {
  return newShareToken();
}

export function hashExportDownloadToken(token: string): string {
  return hashShareToken(token);
}

export function pseudonymExportActor(clubId: string, userId: number): string {
  return createHash('sha256').update(`export:${clubId}:${userId}`).digest('hex').slice(0, 12);
}

export async function saveExportDownload(
  db: DataSource | EntityManager,
  input: {
    clubId: string;
    ownerUserId: number;
    token: string;
    payload: Omit<ExportDownloadPayload, 'usedAt'>;
  },
): Promise<void> {
  await savePlanningRecord(db, {
    id: planningRecordId('export-download'),
    clubId: input.clubId,
    kind: 'export-download',
    ownerUserId: input.ownerUserId,
    tokenHash: hashExportDownloadToken(input.token),
    payload: { ...input.payload, usedAt: null },
  });
}

export async function saveExportAudit(
  db: DataSource | EntityManager,
  input: { clubId: string; payload: ExportAuditPayload },
): Promise<void> {
  await savePlanningRecord(db, {
    id: planningRecordId('export-audit'),
    clubId: input.clubId,
    kind: 'export-audit',
    payload: input.payload,
  });
}

export async function consumeExportDownload(
  db: DataSource,
  token: string,
  clubId: string,
): Promise<ExportDownloadPayload | null> {
  const tokenHash = hashExportDownloadToken(token);
  return db.transaction(async (manager) => {
    const rows = (await manager.query(
      `SELECT id, club_id AS clubId, kind, event_type AS eventType, event_id AS eventId, owner_user_id AS ownerUserId,
              person_type AS personType, person_id AS personId, token_hash AS tokenHash, payload,
              created_at AS createdAt, updated_at AS updatedAt
         FROM planning_records WHERE token_hash = ? AND kind = 'export-download' LIMIT 1 FOR UPDATE`,
      [tokenHash],
    )) as Array<Record<string, unknown>>;
    const row = rows[0];
    if (!row) return null;
    if (String(row.clubId) !== clubId) return null;

    let payload: ExportDownloadPayload;
    try {
      payload = JSON.parse(String(row.payload ?? '{}')) as ExportDownloadPayload;
    } catch {
      return null;
    }
    if (payload.usedAt) return null;
    if (new Date(payload.expiresAt).getTime() <= Date.now()) {
      await manager.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [row.id, clubId]);
      return null;
    }

    const next: ExportDownloadPayload = { ...payload, usedAt: new Date().toISOString() };
    await manager.query(
      `UPDATE planning_records SET payload = ?, updated_at = CURRENT_TIMESTAMP(6) WHERE id = ? AND club_id = ?`,
      [JSON.stringify(next), row.id, clubId],
    );
    return payload;
  });
}

export function buildExportDownloadToken(): { token: string; expiresAt: string } {
  return {
    token: newExportDownloadToken(),
    expiresAt: new Date(Date.now() + EXPORT_DOWNLOAD_TTL_MS).toISOString(),
  };
}
