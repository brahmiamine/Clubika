import { randomUUID } from 'node:crypto';
import { MoreThan } from 'typeorm';
import type { DataSource } from 'typeorm';
import type { NonAccountRightsRequestEntity, UserEntity } from '@/lib/db/schemas';
import { isPlaceholderEmail } from '@/lib/auth/placeholder-account';
import { hasFuturePlanningAssignments } from '@/lib/planning/person-link';
import { findUserReferences } from '@/lib/planning/user-references';
import { readAppSettings } from '@/lib/settings-store';
import {
  ContactLifecycleError,
  FUNCTIONAL_LABEL_PREFIX,
  RIGHTS_TYPES,
  type RightsType,
} from './constants';
import { hashContactLookup, isKnown } from './format';
import { loadContactMeta, markOpposition } from './meta';

const DUPLICATE_WINDOW_MS = 15 * 60 * 1000;

export function parseRightsType(raw: unknown): RightsType {
  if (!isKnown(raw, RIGHTS_TYPES)) {
    throw new ContactLifecycleError('Type de demande inconnu.', 400);
  }
  return raw;
}

export async function hasRecentDuplicateRequest(
  db: DataSource,
  clubId: string,
  emailHash: string | null,
  phoneHash: string | null,
): Promise<boolean> {
  const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
  const repo = db.getRepository<NonAccountRightsRequestEntity>('NonAccountRightsRequest');
  const recent = await repo.find({
    where: { clubId, createdAt: MoreThan(since) },
  });
  return recent.some((row) => (
    (emailHash && row.subjectEmailHash === emailHash)
    || (phoneHash && row.subjectPhoneHash === phoneHash)
  ));
}

export async function createRightsRequest(
  db: DataSource,
  input: {
    clubId: string;
    type: RightsType;
    email?: string | null;
    telephone?: string | null;
  },
): Promise<NonAccountRightsRequestEntity> {
  const email = input.email?.trim().toLowerCase() || '';
  const telephone = input.telephone?.trim() || '';
  if (!email && !telephone) {
    throw new ContactLifecycleError('Indiquez un email ou un téléphone pour relier la demande.', 400);
  }
  const subjectEmailHash = email ? hashContactLookup(input.clubId, email) : null;
  const subjectPhoneHash = telephone ? hashContactLookup(input.clubId, telephone) : null;
  if (await hasRecentDuplicateRequest(db, input.clubId, subjectEmailHash, subjectPhoneHash)) {
    throw new ContactLifecycleError('Demande déjà reçue. Réessayez plus tard.', 429);
  }
  const repo = db.getRepository<NonAccountRightsRequestEntity>('NonAccountRightsRequest');
  return repo.save({
    id: randomUUID(),
    clubId: input.clubId,
    type: input.type,
    subjectEmailHash,
    subjectPhoneHash,
    status: 'received',
    createdAt: new Date(),
    processedAt: null,
  });
}

export async function findUnclaimedMatches(
  db: DataSource,
  clubId: string,
  hashes: { emailHash: string | null; phoneHash: string | null },
): Promise<UserEntity[]> {
  const users = await db.getRepository<UserEntity>('User').find({ where: { clubId } });
  return users.filter((user) => {
    if (user.claimedAt != null) return false;
    if (hashes.phoneHash && user.telephone && hashContactLookup(clubId, user.telephone) === hashes.phoneHash) {
      return true;
    }
    if (
      hashes.emailHash
      && user.email
      && !isPlaceholderEmail(user.email)
      && hashContactLookup(clubId, user.email) === hashes.emailHash
    ) {
      return true;
    }
    return false;
  });
}

async function anonymizeUnclaimed(db: DataSource, user: UserEntity): Promise<void> {
  const repo = db.getRepository<UserEntity>('User');
  user.nom = `${FUNCTIONAL_LABEL_PREFIX}${user.id}`;
  user.telephone = null;
  await repo.save(user);
  const meta = await loadContactMeta(db, user.id);
  if (meta) {
    meta.status = 'orphan';
    await db.getRepository('NonAccountContactMeta').save(meta);
  }
}

export async function applyRightsAction(
  db: DataSource,
  request: NonAccountRightsRequestEntity,
  action: 'opposition' | 'erasure' | 'acknowledge',
): Promise<void> {
  const matches = await findUnclaimedMatches(db, request.clubId, {
    emailHash: request.subjectEmailHash,
    phoneHash: request.subjectPhoneHash,
  });
  const { timeZone } = await readAppSettings(db, request.clubId);

  for (const user of matches) {
    if (action === 'opposition') {
      user.telephone = null;
      await db.getRepository<UserEntity>('User').save(user);
      await markOpposition(db, user.id);
      continue;
    }
    if (action === 'erasure') {
      const referenced = await findUserReferences(db, request.clubId, user.id);
      const hasFuture = await hasFuturePlanningAssignments(db, user.id, timeZone);
      if (referenced.referenced || hasFuture) {
        await anonymizeUnclaimed(db, user);
      } else {
        await db.getRepository<UserEntity>('User').remove(user);
      }
    }
  }

  request.status = 'processed';
  request.processedAt = new Date();
  await db.getRepository<NonAccountRightsRequestEntity>('NonAccountRightsRequest').save(request);
}

export function serializeRightsRequest(row: NonAccountRightsRequestEntity) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.createdAt,
    processedAt: row.processedAt,
    hasEmailHash: Boolean(row.subjectEmailHash),
    hasPhoneHash: Boolean(row.subjectPhoneHash),
  };
}
