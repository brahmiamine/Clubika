import { DataSource, EntityManager } from 'typeorm';
import { MatchAuditLogEntity } from './schemas';
import type { SessionUser } from '@/lib/auth/session';
import { minimizeAuditPayload } from '@/lib/audit/minimize';

export type AuditEntityType =
  | 'MatchOfficial'
  | 'MatchAmical'
  | 'Entrainement'
  | 'Plateau'
  | 'MatchExtra'
  | 'PlanningAttendance'
  | 'PlanningAssignment'
  | 'PlanningPublication'
  | 'PlanningReminder'
  | 'PlanningPreference'
  | 'PlanningAvailability'
  | 'PlanningCollaboration'
  | 'PlanningResource'
  | 'PlanningProductivity'
  | 'PlanningShare'
  | 'AssignmentSwap'
  | 'ChatChannel';

export type AuditAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'attendance'
  | 'auto-assign'
  | 'publish'
  | 'draft'
  | 'cancel'
  | 'reopen'
  | 'manual-reminder'
  | 'respond'
  | 'complete'
  | 'promote'
  | 'bulk'
  | 'share'
  | 'report'
  | 'approve'
  | 'reject'
  | 'archive';

export interface LogAuditEntryInput {
  user: SessionUser | null;
  /**
   * Tenant propriétaire de l'entrée (issue #126). Pour une écriture utilisateur,
   * il est déduit de `user.clubId` ; pour une écriture système/cron
   * (`user: null`), il doit être fourni explicitement. Il n'y a volontairement
   * aucun repli implicite sur APP_CLUB_ID pour une écriture métier.
   */
  clubId?: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export async function logAuditEntry(db: DataSource | EntityManager, entry: LogAuditEntryInput): Promise<void> {
  const clubId = entry.user?.clubId ?? entry.clubId;
  if (!clubId) {
    throw new Error(
      '[audit] Tenant indéterminé (issue #126) : fournir `user` (écriture utilisateur) '
      + 'ou `clubId` (écriture système) — aucun repli implicite sur APP_CLUB_ID.',
    );
  }
  const repo = db.getRepository<MatchAuditLogEntity>('MatchAuditLog');
  await repo.save({
    clubId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    userId: entry.user?.id ?? null,
    userEmail: null,
    userNom: null,
    before: minimizeAuditPayload(entry.before),
    after: minimizeAuditPayload(entry.after),
  });
}
