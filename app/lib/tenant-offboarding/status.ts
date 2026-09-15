import type { DataSource } from 'typeorm';
import { PRIVACY_NO_LEGAL_PROMISE, TOMBSTONE_CLUB_NAME } from './constants';
import { inventoryClub } from './inventory';
import { loadCertificate } from './purge';
import { listProcessorInstructions } from './processors';
import { loadTenant, serializeOffboarding } from './writable';
import { OffboardingError } from './errors';

export async function getOffboardingSnapshot(db: DataSource, clubId: string) {
  const tenant = await loadTenant(db, clubId);
  if (!tenant) throw new OffboardingError('Club non trouvé', 404);
  const [inventory, processors, certificate] = await Promise.all([
    inventoryClub(db, clubId),
    listProcessorInstructions(db, clubId),
    loadCertificate(db, clubId),
  ]);
  return {
    notice: PRIVACY_NO_LEGAL_PROMISE,
    club: {
      id: tenant.id,
      name: tenant.offboardingStatus === 'purged' ? TOMBSTONE_CLUB_NAME : tenant.name,
      active: tenant.active,
    },
    offboarding: serializeOffboarding(tenant),
    inventory,
    processors,
    certificate,
  };
}
