import type { DataSource, EntityManager } from 'typeorm';
import type { PrivacyContactChangeEntity, UserEntity } from '@/lib/db/schemas';
import { revokeAllSessionsForUser } from '@/lib/auth/session';
import { createNotificationForUser } from '@/lib/notifications/service';
import { REVOKED_ICAL_TOKEN } from '@/lib/planning/ical-token';
import { hashPrivacyToken, newPrivacyToken, normalizePrivacyEmail } from './catalog';

type Queryable = DataSource | EntityManager;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_CHANGE_TTL_MS = 2 * 60 * 60 * 1000;

export function isPlausiblePhone(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  return /^\+?[0-9 .\-()]{8,20}$/.test(trimmed);
}

export async function updateSubjectPhone(
  db: DataSource,
  user: UserEntity,
  telephone: string | null,
): Promise<UserEntity> {
  const next = telephone?.trim() || null;
  if (next && !isPlausiblePhone(next)) {
    throw new Error('Téléphone invalide');
  }
  user.telephone = next;
  const saved = await db.getRepository<UserEntity>('User').save(user);
  await createNotificationForUser(db, saved, {
    type: 'privacy-security',
    title: 'Téléphone modifié',
    message: 'Votre numéro de téléphone a été mis à jour. Si vous n’êtes pas à l’origine de ce changement, contactez un administrateur.',
  });
  return saved;
}

export async function requestEmailChange(
  db: DataSource,
  user: UserEntity,
  rawEmail: string,
): Promise<{ confirmToken: string; expiresAt: Date }> {
  const email = normalizePrivacyEmail(rawEmail);
  if (!EMAIL_RE.test(email)) throw new Error('Email invalide');
  if (email === normalizePrivacyEmail(user.email)) throw new Error('Email inchangé');

  const collision = await db.getRepository<UserEntity>('User').findOneBy({
    clubId: user.clubId,
    email,
  });
  if (collision && collision.id !== user.id) {
    throw new Error('Email déjà utilisé dans ce club');
  }

  const token = newPrivacyToken();
  const expiresAt = new Date(Date.now() + CONTACT_CHANGE_TTL_MS);
  await db.getRepository<PrivacyContactChangeEntity>('PrivacyContactChange').save({
    id: hashPrivacyToken(token),
    clubId: user.clubId,
    userId: user.id,
    newEmail: email,
    expiresAt,
    usedAt: null,
  });
  return { confirmToken: token, expiresAt };
}

export async function confirmEmailChange(
  db: DataSource,
  token: string,
): Promise<UserEntity> {
  const repo = db.getRepository<PrivacyContactChangeEntity>('PrivacyContactChange');
  const row = await repo.findOneBy({ id: hashPrivacyToken(token) });
  if (!row || row.usedAt) throw new Error('Lien invalide ou déjà utilisé');
  if (new Date(row.expiresAt).getTime() <= Date.now()) throw new Error('Lien expiré');

  const userRepo = db.getRepository<UserEntity>('User');
  const user = await userRepo.findOneBy({ id: row.userId, clubId: row.clubId });
  if (!user) throw new Error('Compte introuvable');

  const collision = await userRepo.findOneBy({ clubId: user.clubId, email: row.newEmail });
  if (collision && collision.id !== user.id) throw new Error('Email déjà utilisé dans ce club');

  user.email = row.newEmail;
  // Révocation du flux iCal personnel (issue #13) sur changement d'e-mail, comme
  // les sessions ci-dessous : l'identité change, le lien de calendrier connu
  // sous l'ancienne identité ne doit plus fonctionner. L'abonné en régénère un
  // depuis son profil s'il souhaite se réabonner.
  user.icalTokenHash = REVOKED_ICAL_TOKEN.icalTokenHash;
  user.icalTokenCreatedAt = REVOKED_ICAL_TOKEN.icalTokenCreatedAt;
  const saved = await userRepo.save(user);
  row.usedAt = new Date();
  await repo.save(row);
  await revokeAllSessionsForUser(saved.id);
  await createNotificationForUser(db, saved, {
    type: 'privacy-security',
    title: 'Email modifié',
    message: 'Votre adresse e-mail a été mise à jour. Toutes les sessions ont été révoquées. Reconnectez-vous.',
  });
  return saved;
}

export async function applyProcessingFlag(
  db: Queryable,
  user: UserEntity,
  flag: 'restriction' | 'opposition' | 'clear',
): Promise<UserEntity> {
  const now = new Date();
  if (flag === 'restriction') user.processingRestrictedAt = now;
  else if (flag === 'opposition') user.processingOpposedAt = now;
  else {
    user.processingRestrictedAt = null;
    user.processingOpposedAt = null;
  }
  return db.getRepository<UserEntity>('User').save(user);
}
