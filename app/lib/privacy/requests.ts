import type { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { PrivacyRequestEntity, UserEntity } from '@/lib/db/schemas';
import { notifyAdmins } from '@/lib/notifications/service';
import {
  hashPrivacyEmail,
  isPrivacyDecisionCode,
  isPrivacyRequestStatus,
  isPrivacyRequestType,
  type PrivacyDecisionCode,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from './catalog';

type Queryable = DataSource | EntityManager;

export interface CreatePrivacyRequestInput {
  clubId: string;
  type: PrivacyRequestType;
  subjectUserId?: number | null;
  subjectEmail?: string | null;
  identityVerified?: boolean;
  assigneeUserId?: number | null;
}

export function toPrivacyRequestDto(row: PrivacyRequestEntity) {
  return {
    id: row.id,
    clubId: row.clubId,
    type: row.type,
    status: row.status,
    subjectUserId: row.subjectUserId,
    hasEmailHash: Boolean(row.subjectEmailHash),
    identityVerifiedAt: row.identityVerifiedAt,
    dueAt: row.dueAt,
    assigneeUserId: row.assigneeUserId,
    decisionCode: row.decisionCode,
    responseProof: row.responseProof,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

export async function createPrivacyRequest(
  db: Queryable,
  input: CreatePrivacyRequestInput,
): Promise<PrivacyRequestEntity> {
  if (!isPrivacyRequestType(input.type)) {
    throw new Error('Type de demande invalide');
  }
  const repo = db.getRepository<PrivacyRequestEntity>('PrivacyRequest');
  const identityVerified = input.identityVerified === true && input.subjectUserId != null;
  return repo.save({
    id: `dsr:${randomUUID()}`,
    clubId: input.clubId,
    type: input.type,
    status: identityVerified ? 'received' : 'identity_pending',
    subjectUserId: input.subjectUserId ?? null,
    subjectEmailHash: input.subjectEmail ? hashPrivacyEmail(input.clubId, input.subjectEmail) : null,
    identityVerifiedAt: identityVerified ? new Date() : null,
    dueAt: null,
    assigneeUserId: input.assigneeUserId ?? null,
    decisionCode: null,
    responseProof: null,
    completedAt: null,
  });
}

export async function listPrivacyRequestsForClub(
  db: Queryable,
  clubId: string,
): Promise<PrivacyRequestEntity[]> {
  return db.getRepository<PrivacyRequestEntity>('PrivacyRequest').find({
    where: { clubId },
    order: { createdAt: 'DESC' },
    take: 200,
  });
}

export async function listPrivacyRequestsForUser(
  db: Queryable,
  clubId: string,
  userId: number,
): Promise<PrivacyRequestEntity[]> {
  return db.getRepository<PrivacyRequestEntity>('PrivacyRequest').find({
    where: { clubId, subjectUserId: userId },
    order: { createdAt: 'DESC' },
    take: 50,
  });
}

export async function getPrivacyRequest(
  db: Queryable,
  clubId: string,
  id: string,
): Promise<PrivacyRequestEntity | null> {
  return db.getRepository<PrivacyRequestEntity>('PrivacyRequest').findOneBy({ id, clubId });
}

export interface PatchPrivacyRequestInput {
  status?: PrivacyRequestStatus;
  decisionCode?: PrivacyDecisionCode | null;
  responseProof?: string | null;
  assigneeUserId?: number | null;
  dueAt?: Date | null;
  claimedEmail?: string | null;
}

export async function patchPrivacyRequest(
  db: Queryable,
  row: PrivacyRequestEntity,
  patch: PatchPrivacyRequestInput,
): Promise<PrivacyRequestEntity> {
  if (patch.status !== undefined) {
    if (!isPrivacyRequestStatus(patch.status)) throw new Error('Statut invalide');
    row.status = patch.status;
  }
  if (patch.decisionCode !== undefined) {
    if (patch.decisionCode !== null && !isPrivacyDecisionCode(patch.decisionCode)) {
      throw new Error('Code de décision invalide');
    }
    row.decisionCode = patch.decisionCode;
  }
  if (patch.responseProof !== undefined) {
    const proof = patch.responseProof?.trim() || null;
    if (proof && proof.length > 191) throw new Error('Preuve trop longue');
    row.responseProof = proof;
  }
  if (patch.assigneeUserId !== undefined) row.assigneeUserId = patch.assigneeUserId;
  if (patch.dueAt !== undefined) row.dueAt = patch.dueAt;
  if (patch.claimedEmail) {
    const hash = hashPrivacyEmail(row.clubId, patch.claimedEmail);
    if (row.subjectEmailHash && row.subjectEmailHash !== hash) {
      throw new Error('Identité non concordante');
    }
    row.subjectEmailHash = hash;
    const user = await db.getRepository<UserEntity>('User').findOneBy({
      clubId: row.clubId,
      email: patch.claimedEmail.trim().toLowerCase(),
    });
    if (user) {
      row.subjectUserId = user.id;
      row.identityVerifiedAt = new Date();
      if (row.status === 'identity_pending') row.status = 'in_review';
    }
  }
  if (row.status === 'completed' || row.status === 'cancelled') {
    row.completedAt = row.completedAt ?? new Date();
  }
  return db.getRepository<PrivacyRequestEntity>('PrivacyRequest').save(row);
}

export async function notifyAdminsOfPrivacyRequest(
  db: DataSource,
  type: PrivacyRequestType,
  requestId: string,
): Promise<void> {
  await notifyAdmins(db, {
    type: 'privacy-request',
    title: 'Demande d’exercice de droits',
    message: `Une demande ${type} (${requestId}) est à traiter. Aucun dossier nominatif n’est recopié dans les journaux.`,
  });
}
