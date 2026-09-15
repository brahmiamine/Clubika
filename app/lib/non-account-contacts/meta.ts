import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type { NonAccountContactMetaEntity, ClubNoticeConfigEntity } from '@/lib/db/schemas';
import { normalizePlanningFunctions } from '@/lib/auth/roles';
import {
  CONTACT_PROVENANCES,
  CONTACT_PURPOSES,
  CONTACT_CATEGORIES,
  CONTACT_STATUSES,
  ContactLifecycleError,
  type ContactCategory,
  type ContactProvenance,
  type ContactPurpose,
  type ContactStatus,
  type NoticeChannel,
} from './constants';
import { isKnown } from './format';

export async function loadNoticeConfig(db: DataSource, clubId: string): Promise<ClubNoticeConfigEntity | null> {
  return db.getRepository<ClubNoticeConfigEntity>('ClubNoticeConfig').findOneBy({ clubId });
}

export async function upsertNoticeConfig(
  db: DataSource,
  clubId: string,
  input: { noticeVersion?: string; noticeText?: string },
): Promise<ClubNoticeConfigEntity> {
  const repo = db.getRepository<ClubNoticeConfigEntity>('ClubNoticeConfig');
  let row = await repo.findOneBy({ clubId });
  if (!row) {
    row = repo.create({
      clubId,
      noticeVersion: '',
      noticeText: '',
      updatedAt: new Date(),
    });
  }
  if (typeof input.noticeVersion === 'string') {
    row.noticeVersion = input.noticeVersion.trim().slice(0, 64);
  }
  if (typeof input.noticeText === 'string') {
    row.noticeText = input.noticeText.trim().slice(0, 4000);
  }
  return repo.save(row);
}

export async function loadContactMeta(db: DataSource, userId: number) {
  return db.getRepository<NonAccountContactMetaEntity>('NonAccountContactMeta').findOneBy({ userId });
}

export function parseProvenance(raw: unknown): ContactProvenance | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!isKnown(raw, CONTACT_PROVENANCES)) {
    throw new ContactLifecycleError('Provenance inconnue. Choisissez une option du catalogue (aucune base légale libre).', 400);
  }
  return raw;
}

export function parsePurpose(raw: unknown): ContactPurpose {
  if (raw === undefined || raw === null || raw === '') return 'organisation_planning';
  if (!isKnown(raw, CONTACT_PURPOSES)) {
    throw new ContactLifecycleError('Finalité inconnue. Choisissez une option du catalogue club.', 400);
  }
  return raw;
}

export function parseCategory(raw: unknown): ContactCategory {
  if (!isKnown(raw, CONTACT_CATEGORIES)) {
    throw new ContactLifecycleError('Catégorie inconnue. Choisissez officiel, encadrant ou accompagnateur.', 400);
  }
  return raw;
}

export function parseOptionalCategory(raw: unknown): ContactCategory | null {
  if (raw === undefined || raw === null || raw === '') return null;
  return parseCategory(raw);
}

export function parseStatus(raw: unknown): ContactStatus | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!isKnown(raw, CONTACT_STATUSES)) {
    throw new ContactLifecycleError('Statut inconnu.', 400);
  }
  return raw;
}

export function inferCategoryFromPlanningFunctions(planningFunctions: string[]): ContactCategory {
  const functions = normalizePlanningFunctions(planningFunctions);
  if (functions.includes('arbitre_club')) return 'officiel';
  if (functions.includes('encadrant')) return 'encadrant';
  if (functions.includes('accompagnateur')) return 'accompagnateur';
  return 'encadrant';
}

export function normalizeTelephone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

export function assertTelephoneAllowed(options: {
  telephone: string | null;
  previousTelephone?: string | null;
  provenance: ContactProvenance | null;
  existingProvenance?: string | null;
}): void {
  if (!options.telephone) return;
  if (options.previousTelephone && options.previousTelephone === options.telephone && options.existingProvenance) {
    return;
  }
  if (options.provenance || options.existingProvenance) return;
  throw new ContactLifecycleError(
    'Un téléphone ne peut être enregistré que si la provenance de la fiche est documentée. '
    + 'Sans provenance, la fiche reste un identifiant fonctionnel (nom / fiche-#).',
    400,
  );
}

export async function upsertContactMeta(
  db: DataSource,
  input: {
    userId: number;
    clubId: string;
    category: ContactCategory;
    provenance: ContactProvenance | null;
    purpose: ContactPurpose;
    recordedByUserId: number;
    status?: string;
  },
): Promise<NonAccountContactMetaEntity> {
  const repo = db.getRepository<NonAccountContactMetaEntity>('NonAccountContactMeta');
  let row = await repo.findOneBy({ userId: input.userId });
  const now = new Date();
  if (!row) {
    row = repo.create({
      id: randomUUID(),
      userId: input.userId,
      clubId: input.clubId,
      category: input.category,
      provenance: input.provenance,
      purpose: input.purpose,
      collectedAt: now,
      recordedByUserId: input.recordedByUserId,
      noticeVersion: null,
      noticeChannel: 'not_sent',
      noticeAt: null,
      noticeResult: 'pending',
      opposedAt: null,
      status: input.status ?? 'active',
    });
  } else {
    if (input.provenance) row.provenance = input.provenance;
    row.purpose = input.purpose;
    row.category = input.category;
    if (input.status) row.status = input.status;
  }
  return repo.save(row);
}

export async function recordNoticeProof(
  db: DataSource,
  userId: number,
  clubId: string,
  channel: NoticeChannel,
): Promise<void> {
  const config = await loadNoticeConfig(db, clubId);
  const repo = db.getRepository<NonAccountContactMetaEntity>('NonAccountContactMeta');
  const row = await repo.findOneBy({ userId });
  if (!row) return;
  if (!config?.noticeVersion) {
    row.noticeChannel = channel;
    row.noticeResult = 'pending';
    await repo.save(row);
    return;
  }
  row.noticeVersion = config.noticeVersion;
  row.noticeChannel = channel;
  row.noticeAt = new Date();
  row.noticeResult = 'sent';
  await repo.save(row);
}

export async function markOpposition(db: DataSource, userId: number): Promise<void> {
  const repo = db.getRepository<NonAccountContactMetaEntity>('NonAccountContactMeta');
  const row = await repo.findOneBy({ userId });
  if (!row) return;
  row.opposedAt = new Date();
  row.status = 'refused';
  await repo.save(row);
}

export function serializeMeta(row: NonAccountContactMetaEntity | null) {
  if (!row) return null;
  return {
    category: row.category,
    provenance: row.provenance,
    purpose: row.purpose,
    collectedAt: row.collectedAt,
    notice: {
      version: row.noticeVersion,
      channel: row.noticeChannel,
      at: row.noticeAt,
      result: row.noticeResult,
    },
    opposedAt: row.opposedAt,
    status: row.status,
  };
}
