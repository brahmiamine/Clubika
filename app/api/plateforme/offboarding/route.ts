import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import type { ClubTenantEntity } from '@/lib/db/schemas';
import { serializeOffboarding } from '@/lib/tenant-offboarding/writable';
import { TOMBSTONE_CLUB_NAME } from '@/lib/tenant-offboarding/constants';

export async function GET(request: NextRequest) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;
  try {
    const db = await getDb();
    const clubs = await db.getRepository<ClubTenantEntity>('ClubTenant').find({ order: { updatedAt: 'DESC' } });
    const offboarding = clubs
      .filter((club) => club.offboardingStatus !== 'none' || club.legalHoldActive)
      .map((club) => ({
        id: club.id,
        name: club.offboardingStatus === 'purged' ? TOMBSTONE_CLUB_NAME : club.name,
        offboarding: serializeOffboarding(club),
      }));
    return NextResponse.json({ clubs: offboarding });
  } catch (error) {
    console.error('Error listing offboarding clubs:', error);
    return NextResponse.json({ error: 'Impossible de charger l’offboarding' }, { status: 500 });
  }
}
