import type { DataSource } from 'typeorm';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import {
  LEGAL_HOLD_MOTIVES,
  LEGAL_HOLD_SCOPES,
  type LegalHoldMotive,
  type LegalHoldScope,
} from './constants';
import { OffboardingError } from './errors';
import { recordOffboardingEvent } from './events';
import { freezeClub } from './freeze';

export async function setLegalHold(
  db: DataSource,
  clubId: string,
  platformAdminId: number,
  input: {
    motive: string;
    scope: string;
    expiresAt: string;
  },
): Promise<ClubTenantEntity> {
  if (!LEGAL_HOLD_MOTIVES.includes(input.motive as LegalHoldMotive)) {
    throw new OffboardingError('Motif de legal hold non autorisé', 400);
  }
  if (!LEGAL_HOLD_SCOPES.includes(input.scope as LegalHoldScope)) {
    throw new OffboardingError('Périmètre de legal hold non autorisé', 400);
  }
  const expiresAt = new Date(input.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new OffboardingError('Date d’expiration du legal hold invalide', 400);
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new OffboardingError('La date d’expiration du legal hold doit être future', 400);
  }

  let tenant = await db.getRepository<ClubTenantEntity>('ClubTenant').findOneBy({ id: clubId });
  if (!tenant) throw new OffboardingError('Club non trouvé', 404);
  if (tenant.offboardingStatus === 'purged') {
    throw new OffboardingError('Impossible : le club est déjà supprimé', 409);
  }
  if (tenant.offboardingStatus !== 'frozen') {
    tenant = await freezeClub(db, clubId, {
      platformAdminId,
      retentionUntil: tenant.retentionUntil,
    });
  }

  tenant.legalHoldActive = true;
  tenant.legalHoldMotive = input.motive;
  tenant.legalHoldScope = input.scope;
  tenant.legalHoldExpiresAt = expiresAt;
  tenant.legalHoldApprovedBy = platformAdminId;
  tenant.legalHoldCreatedAt = tenant.legalHoldCreatedAt ?? new Date();
  await db.getRepository<ClubTenantEntity>('ClubTenant').save(tenant);
  await recordOffboardingEvent(db, {
    clubId,
    action: 'legal-hold-set',
    platformAdminId,
    payload: { motive: input.motive, scope: input.scope, expiresAt: expiresAt.toISOString() },
  });
  return tenant;
}

export async function clearLegalHold(
  db: DataSource,
  clubId: string,
  platformAdminId: number,
): Promise<ClubTenantEntity> {
  const repo = db.getRepository<ClubTenantEntity>('ClubTenant');
  const tenant = await repo.findOneBy({ id: clubId });
  if (!tenant) throw new OffboardingError('Club non trouvé', 404);
  tenant.legalHoldActive = false;
  tenant.legalHoldMotive = null;
  tenant.legalHoldScope = null;
  tenant.legalHoldExpiresAt = null;
  tenant.legalHoldApprovedBy = null;
  tenant.legalHoldCreatedAt = null;
  await repo.save(tenant);
  await recordOffboardingEvent(db, {
    clubId,
    action: 'legal-hold-clear',
    platformAdminId,
  });
  return tenant;
}
