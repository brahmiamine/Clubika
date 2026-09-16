import { randomBytes } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import { revokeAllSessionsForClub } from '@/lib/auth/session';
import { OffboardingError } from './errors';
import { recordOffboardingEvent } from './events';
import { seedProcessorInstructions } from './processors';
import { tableExists } from './sql';

export { OffboardingError };

async function revokeCapabilities(db: DataSource, clubId: string): Promise<void> {
  await revokeAllSessionsForClub(clubId);

  if (await tableExists(db, 'invitations')) {
    await db.query(
      'UPDATE invitations SET expiresAt = ?, pendingEmailKey = NULL WHERE clubId = ? AND usedAt IS NULL',
      [new Date(), clubId],
    );
  }

  if (await tableExists(db, 'password_reset_tokens')) {
    await db.query(
      `DELETE pr FROM password_reset_tokens pr
       INNER JOIN users u ON u.id = pr.userId
       WHERE u.clubId = ?`,
      [clubId],
    );
  }

  if (await tableExists(db, 'users')) {
    const users = await db.query('SELECT id FROM users WHERE clubId = ?', [clubId]) as Array<{ id: number }>;
    for (const user of users) {
      const token = `revoked-${clubId}-${user.id}-${randomBytes(8).toString('hex')}`;
      await db.query('UPDATE users SET icalToken = ? WHERE id = ?', [token, user.id]);
    }
  }

  if (await tableExists(db, 'push_subscriptions')) {
    await db.query(
      `DELETE ps FROM push_subscriptions ps
       INNER JOIN users u ON u.id = ps.user_id
       WHERE u.clubId = ?`,
      [clubId],
    );
  }

  if (await tableExists(db, 'planning_notification_outbox')) {
    await db.query(
      `UPDATE planning_notification_outbox o
       INNER JOIN users u ON u.id = o.user_id
       SET o.status = 'dead', o.last_error = 'Club gelé (offboarding)'
       WHERE u.clubId = ? AND o.status IN ('pending', 'retry')`,
      [clubId],
    );
  }
}

export async function freezeClub(
  db: DataSource,
  clubId: string,
  options: {
    platformAdminId: number;
    retentionUntil: Date | null;
  },
): Promise<ClubTenantEntity> {
  const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
  const tenant = await repo.findOneBy({ id: clubId });
  if (!tenant) throw new OffboardingError('Club non trouvé', 404);
  if (tenant.offboardingStatus === 'purged') {
    throw new OffboardingError('Ce club est déjà supprimé', 409);
  }

  tenant.active = false;
  tenant.offboardingStatus = 'frozen';
  tenant.frozenAt = tenant.frozenAt ?? new Date();
  tenant.retentionUntil = options.retentionUntil;
  await repo.save(tenant);

  await revokeCapabilities(db, clubId);
  await seedProcessorInstructions(db, tenant);
  await recordOffboardingEvent(db, {
    clubId,
    action: 'freeze',
    platformAdminId: options.platformAdminId,
    payload: {
      retentionUntil: options.retentionUntil?.toISOString() ?? null,
    },
  });
  return tenant;
}

export async function cancelFreeze(
  db: DataSource,
  clubId: string,
  platformAdminId: number,
): Promise<ClubTenantEntity> {
  const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
  const tenant = await repo.findOneBy({ id: clubId });
  if (!tenant) throw new OffboardingError('Club non trouvé', 404);
  if (tenant.offboardingStatus === 'purged') {
    throw new OffboardingError('Impossible d’annuler : le club est déjà supprimé', 409);
  }
  if (tenant.legalHoldActive) {
    throw new OffboardingError('Impossible d’annuler tant qu’un legal hold est actif', 409);
  }
  if (tenant.offboardingStatus !== 'frozen') {
    throw new OffboardingError('Le club n’est pas gelé', 409);
  }

  tenant.offboardingStatus = 'none';
  tenant.frozenAt = null;
  tenant.retentionUntil = null;
  await repo.save(tenant);
  await recordOffboardingEvent(db, {
    clubId,
    action: 'cancel-freeze',
    platformAdminId,
  });
  return tenant;
}
