import { randomUUID } from 'node:crypto';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import type {
  InvitationEntity,
  PasswordResetTokenEntity,
  UserEntity,
  UserSessionEntity,
} from '@/lib/db/schemas';
import { findUserReferences } from '@/lib/planning/user-references';
import { removeAllPushSubscriptionsForUser } from '@/lib/push/store';
import { REVOKED_ICAL_TOKEN } from '@/lib/planning/ical-token';
import { anonymizePersonEverywhere } from './anonymize';
import {
  ANONYMIZED_DISPLAY_NAME,
  CLOSED_PASSWORD_HASH,
  closedAccountEmail,
  isClosedAccount,
} from './constants';
import {
  accountClosurePreview,
  type AccountClosurePreview,
  type AccountClosureRole,
  type RetainedCategory,
} from './policy';

type Queryable = DataSource | EntityManager;

export class AccountClosureError extends Error {
  constructor(
    public readonly code: 'last-admin' | 'not-found' | 'already-closed',
    message: string,
  ) {
    super(message);
    this.name = 'AccountClosureError';
  }
}

export interface AccountClosureResult {
  userId: number;
  closedAt: string;
  alreadyClosed: boolean;
  processedByRole: AccountClosureRole;
  preview: AccountClosurePreview;
  revoked: {
    sessions: boolean;
    ical: boolean;
    invitations: number;
    push: boolean;
    passwordReset: boolean;
  };
}

interface ClosureRow {
  id: string;
  club_id: string;
  user_id: number;
  requested_at: Date | string | null;
  closed_at: Date | string;
  requested_by_role: AccountClosureRole;
  processed_by_role: AccountClosureRole;
  retained: RetainedCategory[] | string;
}

function parseRetained(value: RetainedCategory[] | string): RetainedCategory[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as RetainedCategory[] : [];
  } catch {
    return [];
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function loadClosureRow(db: Queryable, userId: number): Promise<ClosureRow | null> {
  const rows = (await db.query(
    `SELECT id, club_id, user_id, requested_at, closed_at, requested_by_role, processed_by_role, retained
       FROM account_closures WHERE user_id = ? LIMIT 1`,
    [userId],
  )) as ClosureRow[];
  return rows[0] ?? null;
}

export async function previewAccountClosure(
  db: Queryable,
  clubId: string,
  userId: number,
): Promise<AccountClosurePreview> {
  const references = await findUserReferences(db, clubId, userId);
  const authored = (await db.query(
    `SELECT 1 AS ok FROM planning_records
      WHERE club_id = ? AND (owner_user_id = ? OR person_id = ?)
        AND kind IN ('comment', 'post-event-report', 'assignment-swap')
      LIMIT 1`,
    [clubId, userId, userId],
  )) as Array<{ ok: number }>;
  return accountClosurePreview(references, authored.length > 0);
}

async function resultFromExisting(
  db: Queryable,
  user: UserEntity,
  processedByRole: AccountClosureRole,
): Promise<AccountClosureResult> {
  const row = await loadClosureRow(db, user.id);
  const preview = row
    ? {
        displayName: ANONYMIZED_DISPLAY_NAME,
        retained: parseRetained(row.retained),
        references: [],
      }
    : await previewAccountClosure(db, user.clubId, user.id);
  return {
    userId: user.id,
    closedAt: user.closedAt ? iso(user.closedAt) : iso(row?.closed_at ?? new Date()),
    alreadyClosed: true,
    processedByRole: row?.processed_by_role ?? processedByRole,
    preview,
    revoked: {
      sessions: true,
      ical: true,
      invitations: 0,
      push: true,
      passwordReset: true,
    },
  };
}

export async function closeAccount(
  db: Queryable,
  input: {
    target: UserEntity;
    processedByUserId: number;
    processedByRole: AccountClosureRole;
    dryRun?: boolean;
    activeAdminCount: number;
  },
): Promise<AccountClosureResult> {
  const { target, processedByRole, dryRun = false, activeAdminCount } = input;
  if (isClosedAccount(target)) {
    return resultFromExisting(db, target, processedByRole);
  }

  if (target.accessRole === 'admin' && target.active && activeAdminCount <= 1) {
    throw new AccountClosureError(
      'last-admin',
      'Impossible de fermer le dernier administrateur : transférez d’abord le rôle à un autre compte.',
    );
  }

  const preview = await previewAccountClosure(db, target.clubId, target.id);
  if (dryRun) {
    return {
      userId: target.id,
      closedAt: new Date().toISOString(),
      alreadyClosed: false,
      processedByRole,
      preview,
      revoked: {
        sessions: true,
        ical: true,
        invitations: 0,
        push: true,
        passwordReset: true,
      },
    };
  }

  const { authoredOperationalRecords } = await anonymizePersonEverywhere(db, target.clubId, target.id);
  const livePreview = accountClosurePreview(
    await findUserReferences(db, target.clubId, target.id),
    authoredOperationalRecords || preview.retained.some((item) => item.category === 'authored-operational-records' && item.kept),
  );

  const invitationRepo = db.getRepository<InvitationEntity>('Invitation');
  const pending = await invitationRepo.find({
    where: [
      { clubId: target.clubId, personId: target.id, usedAt: IsNull() },
      { clubId: target.clubId, email: target.email, usedAt: IsNull() },
    ],
  });
  const uniquePending = [...new Map(pending.map((invitation) => [invitation.id, invitation])).values()];
  const now = new Date();
  let invitations = 0;
  for (const invitation of uniquePending) {
    invitation.expiresAt = now;
    invitation.pendingEmailKey = null;
    invitation.email = null;
    if (invitation.personId === target.id) invitation.personNom = ANONYMIZED_DISPLAY_NAME;
    await invitationRepo.save(invitation);
    invitations += 1;
  }
  await invitationRepo
    .createQueryBuilder()
    .update()
    .set({ personNom: ANONYMIZED_DISPLAY_NAME })
    .where('clubId = :clubId AND personId = :personId', { clubId: target.clubId, personId: target.id })
    .execute();

  const resetRepo = db.getRepository<PasswordResetTokenEntity>('PasswordResetToken');
  await resetRepo.delete({ userId: target.id });

  await removeAllPushSubscriptionsForUser(db, target.id);

  await db.getRepository<UserSessionEntity>('UserSession')
    .createQueryBuilder()
    .update()
    .set({ revokedAt: now })
    .where('userId = :userId', { userId: target.id })
    .andWhere('revokedAt IS NULL')
    .execute();

  const requestedAt = target.closureRequestedAt ?? (processedByRole === 'self' ? now : null);
  target.nom = ANONYMIZED_DISPLAY_NAME;
  target.email = closedAccountEmail(target.id);
  target.telephone = null;
  target.passwordHash = CLOSED_PASSWORD_HASH;
  target.indisponibilites = null;
  target.notifyChannel = 'push';
  target.active = false;
  target.claimedAt = null;
  target.accessRole = 'dirigeant';
  // Révocation du flux iCal personnel (issue #13) : plus de flux actif du tout,
  // plutôt qu'une rotation vers un jeton jamais restitué — même effet (l'ancienne
  // URL cesse de fonctionner) sans générer de secret inutile.
  target.icalTokenHash = REVOKED_ICAL_TOKEN.icalTokenHash;
  target.icalTokenCreatedAt = REVOKED_ICAL_TOKEN.icalTokenCreatedAt;
  target.closedAt = now;
  target.closureRequestedAt = requestedAt;
  target.closedByUserId = input.processedByUserId;
  await db.getRepository<UserEntity>('User').save(target);

  await db.query(
    `INSERT INTO account_closures
      (id, club_id, user_id, requested_at, closed_at, requested_by_role, processed_by_role, retained)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      closed_at = VALUES(closed_at),
      processed_by_role = VALUES(processed_by_role),
      retained = VALUES(retained)`,
    [
      randomUUID(),
      target.clubId,
      target.id,
      requestedAt,
      now,
      processedByRole,
      processedByRole,
      JSON.stringify(livePreview.retained),
    ],
  );

  return {
    userId: target.id,
    closedAt: now.toISOString(),
    alreadyClosed: false,
    processedByRole,
    preview: livePreview,
    revoked: {
      sessions: true,
      ical: true,
      invitations,
      push: true,
      passwordReset: true,
    },
  };
}

export async function lockTargetAndActiveAdmins(
  manager: EntityManager,
  clubId: string,
  targetId: number,
): Promise<UserEntity[]> {
  return manager
    .getRepository<UserEntity>('User')
    .createQueryBuilder('user')
    .setLock('pessimistic_write')
    .where(
      'user.clubId = :clubId AND (user.id = :targetId OR (user.active = :active AND user.accessRole = :role AND user.closedAt IS NULL))',
      { clubId, targetId, active: true, role: 'admin' },
    )
    .orderBy('user.id', 'ASC')
    .getMany();
}

export function countLockedActiveAdmins(locked: readonly UserEntity[]): number {
  return locked.filter((candidate) => candidate.active && candidate.accessRole === 'admin' && !isClosedAccount(candidate)).length;
}

export async function markClosureRequested(
  db: Queryable,
  user: UserEntity,
): Promise<Date> {
  if (isClosedAccount(user)) {
    return user.closureRequestedAt ?? user.closedAt ?? new Date();
  }
  if (user.closureRequestedAt) return user.closureRequestedAt;
  user.closureRequestedAt = new Date();
  await db.getRepository<UserEntity>('User').save(user);
  return user.closureRequestedAt;
}
