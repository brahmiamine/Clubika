import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { ClubTenantEntity, TenantProcessorInstructionEntity } from '@/lib/db/schemas';
import {
  PROCESSOR_IDS,
  PROCESSOR_STATUSES,
  type ProcessorId,
  type ProcessorStatus,
} from './constants';
import { recordOffboardingEvent } from './events';
import { OffboardingError } from './errors';
import { countQuery, tableExists } from './sql';

export function processorLabel(id: ProcessorId): string {
  switch (id) {
    case 'smtp':
      return 'Messagerie SMTP du club';
    case 'web_push':
      return 'Web Push (VAPID)';
    case 'whatsapp':
      return 'WhatsApp (si configuré)';
    case 'scraper':
      return 'Collecte de calendrier externe';
    default:
      return id;
  }
}

async function initialStatus(db: DataSource, tenant: ClubTenantEntity, id: ProcessorId): Promise<ProcessorStatus> {
  if (id === 'smtp') {
    return tenant.smtpHost ? 'pending' : 'not_applicable';
  }
  if (id === 'scraper') {
    return tenant.matchesUrlKey ? 'pending' : 'not_applicable';
  }
  if (id === 'whatsapp') {
    const channel = tenant.featuresJson?.toLowerCase().includes('whatsapp');
    return channel ? 'pending' : 'not_applicable';
  }
  if (id === 'web_push' && await tableExists(db, 'push_subscriptions') && await tableExists(db, 'users')) {
    const n = await countQuery(
      db,
      `SELECT COUNT(*) AS n FROM push_subscriptions ps
       INNER JOIN users u ON u.id = ps.user_id WHERE u.clubId = ?`,
      [tenant.id],
    );
    return n > 0 ? 'pending' : 'not_applicable';
  }
  return 'not_applicable';
}

export async function seedProcessorInstructions(db: DataSource, tenant: ClubTenantEntity): Promise<void> {
  const repo = db.getRepository<TenantProcessorInstructionEntity>('TenantProcessorInstruction');
  const now = new Date();
  for (const processorId of PROCESSOR_IDS) {
    const existing = await repo.findOneBy({ clubId: tenant.id, processorId });
    if (existing) continue;
    const status = await initialStatus(db, tenant, processorId);
    await repo.save({
      id: randomUUID(),
      clubId: tenant.id,
      processorId,
      status,
      instructedAt: now,
      responseAt: status === 'not_applicable' ? now : null,
    });
  }
}

export async function listProcessorInstructions(db: DataSource, clubId: string) {
  const repo = db.getRepository<TenantProcessorInstructionEntity>('TenantProcessorInstruction');
  const rows = await repo.find({ where: { clubId } });
  const byId = new Map(rows.map((row) => [row.processorId, row]));
  return PROCESSOR_IDS.map((id) => {
    const row = byId.get(id);
    return {
      id,
      label: processorLabel(id),
      status: row?.status ?? 'pending',
      instructedAt: row?.instructedAt ?? null,
      responseAt: row?.responseAt ?? null,
    };
  });
}

export async function acknowledgeProcessor(
  db: DataSource,
  clubId: string,
  platformAdminId: number,
  processorId: string,
  status: string,
): Promise<void> {
  if (!PROCESSOR_IDS.includes(processorId as ProcessorId)) {
    throw new OffboardingError('Sous-traitant inconnu', 400);
  }
  if (!PROCESSOR_STATUSES.includes(status as ProcessorStatus) || status === 'pending') {
    throw new OffboardingError('Statut de réponse invalide', 400);
  }
  const repo = db.getRepository<TenantProcessorInstructionEntity>('TenantProcessorInstruction');
  let row = await repo.findOneBy({ clubId, processorId });
  const now = new Date();
  if (!row) {
    row = repo.create({
      id: randomUUID(),
      clubId,
      processorId,
      status,
      instructedAt: now,
      responseAt: now,
    });
  } else {
    row.status = status;
    row.responseAt = now;
  }
  await repo.save(row);
  await recordOffboardingEvent(db, {
    clubId,
    action: 'processor-response',
    platformAdminId,
    payload: { processorId, status },
  });
}
