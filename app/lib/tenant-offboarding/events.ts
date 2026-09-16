import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { TenantOffboardingEventEntity } from '@/lib/db/schemas';

export async function recordOffboardingEvent(
  db: DataSource,
  input: {
    clubId: string;
    action: string;
    platformAdminId?: number | null;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const repo = db.getRepository<TenantOffboardingEventEntity>('TenantOffboardingEvent');
  await repo.save({
    id: randomUUID(),
    clubId: input.clubId,
    action: input.action,
    platformAdminId: input.platformAdminId ?? null,
    payloadJson: JSON.stringify(input.payload ?? {}),
  });
}
