import { createHash } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { PrivilegedAuthEventEntity } from '@/lib/db/schemas';

function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

export async function recordPrivilegedAuthEvent(
  db: DataSource,
  event: {
    action: string;
    actorType: 'platform' | 'club' | 'system';
    actorId?: number | null;
    clubId?: string | null;
    email?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const safeMetadata: Record<string, unknown> = { ...(event.metadata ?? {}) };
  delete safeMetadata.password;
  delete safeMetadata.token;
  delete safeMetadata.resetUrl;
  delete safeMetadata.secret;
  delete safeMetadata.recoveryCodes;
  if (event.email) {
    safeMetadata.emailHash = hashEmail(event.email);
  }
  await db.getRepository<PrivilegedAuthEventEntity>('PrivilegedAuthEvent').save({
    action: event.action,
    actorType: event.actorType,
    actorId: event.actorId ?? null,
    clubId: event.clubId ?? null,
    metadata: safeMetadata,
    createdAt: new Date(),
  });
}
