import type { DataSource, EntityManager } from 'typeorm';
import type { ClubTenantEntity } from './schemas';

type Queryable = DataSource | EntityManager;

export async function listActiveClubIds(db: DataSource): Promise<string[]> {
  const rows = await db.getRepository<ClubTenantEntity>('ClubTenant').find({
    where: { active: true },
    select: { id: true },
  });
  if (rows.length > 0) return rows.map((row) => row.id);
  // Aucun club encore enregistré dans club_tenants (première mise en route) :
  // on retombe sur le club unique historique piloté par APP_CLUB_ID.
  return [process.env.APP_CLUB_ID || 'afp'];
}

export async function listActiveClubTenants(db: DataSource): Promise<ClubTenantEntity[]> {
  return db.getRepository<ClubTenantEntity>('ClubTenant').find({
    where: { active: true },
    order: { name: 'ASC' },
  });
}


/**
 * Un club explicitement désactivé est inaccessible. L'absence de ligne conserve
 * la compatibilité avec les installations historiques mono-club.
 */
export async function isClubTenantActive(db: Queryable, clubId: string): Promise<boolean> {
  const tenant = await db.getRepository<ClubTenantEntity>('ClubTenant').findOneBy({ id: clubId });
  return tenant ? tenant.active : true;
}
