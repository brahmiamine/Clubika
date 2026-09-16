import type { MatchAuditLogEntity } from '@/lib/db/schemas';
import { AUDIT_CATALOG_VERSION, auditActorLabel } from './catalog';
import { minimizeAuditPayload } from './minimize';

export interface MatchAuditLogDto {
  id: number;
  clubId: string;
  entityType: string;
  entityId: string;
  action: string;
  userId: number | null;
  actorLabel: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Date | string;
  schemaVersion: typeof AUDIT_CATALOG_VERSION;
}

/**
 * DTO de lecture admin : mêmes règles que l'écriture (catalogue v1),
 * sans e-mail ni nom d'acteur. La minimisation est réappliquée à la lecture
 * pour les lignes historiques non encore migrées.
 */
export function toAuditLogDto(entry: MatchAuditLogEntity): MatchAuditLogDto {
  return {
    id: entry.id,
    clubId: entry.clubId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    userId: entry.userId,
    actorLabel: auditActorLabel(entry.userId),
    before: minimizeAuditPayload(entry.before),
    after: minimizeAuditPayload(entry.after),
    createdAt: entry.createdAt,
    schemaVersion: AUDIT_CATALOG_VERSION,
  };
}
