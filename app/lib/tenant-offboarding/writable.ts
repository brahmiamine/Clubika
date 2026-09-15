import { NextResponse } from 'next/server';
import type { DataSource } from 'typeorm';
import type { ClubTenantEntity } from '@/lib/db/schemas';

export function platformClubWriteBlocked(tenant: ClubTenantEntity): string | null {
  if (tenant.offboardingStatus === 'purged') {
    return 'Ce club a été supprimé. L’identifiant est conservé en tombstone et n’accepte plus d’écritures.';
  }
  if (tenant.legalHoldActive) {
    return 'Legal hold actif : les écritures métier du club sont gelées.';
  }
  if (tenant.offboardingStatus === 'frozen') {
    return 'Club gelé en fin de contrat : nouvelles écritures refusées.';
  }
  return null;
}

export async function loadTenant(db: DataSource, clubId: string): Promise<ClubTenantEntity | null> {
  return db.getRepository<ClubTenantEntity>('ClubTenant').findOneBy({ id: clubId });
}

export async function rejectIfClubNotWritable(
  db: DataSource,
  clubId: string,
): Promise<NextResponse | null> {
  const tenant = await loadTenant(db, clubId);
  if (!tenant) return NextResponse.json({ error: 'Club non trouvé' }, { status: 404 });
  const reason = platformClubWriteBlocked(tenant);
  if (reason) return NextResponse.json({ error: reason }, { status: 409 });
  return null;
}

export function serializeOffboarding(tenant: ClubTenantEntity) {
  return {
    status: tenant.offboardingStatus,
    active: tenant.active,
    frozenAt: tenant.frozenAt,
    retentionUntil: tenant.retentionUntil,
    purgedAt: tenant.purgedAt,
    legalHold: {
      active: Boolean(tenant.legalHoldActive),
      motive: tenant.legalHoldMotive,
      scope: tenant.legalHoldScope,
      expiresAt: tenant.legalHoldExpiresAt,
      approvedBy: tenant.legalHoldApprovedBy,
      createdAt: tenant.legalHoldCreatedAt,
    },
  };
}
