import { logError } from '@/lib/observability/log';
import type { DataSource, EntityManager } from 'typeorm';
import type { AssignmentContact } from '@/types/match';
import type {
  NotificationEntity,
  UserEntity,
} from '@/lib/db/schemas';
import { getCurrentClubId } from '@/lib/auth/club-context';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import { normalizeAccessRole } from '@/lib/auth/roles';
import { triggerPushForUser } from '@/lib/push/service';
import { getPlanningRecord } from '@/lib/planning/records';
import { emitNotificationsChanged } from '@/lib/realtime/hub';
import { CHAT_INBOX_EXCLUDED_TYPES } from './inbox';
import { sendEmail } from './email';
import { sendWhatsAppNotification, isWhatsAppGloballyEnabled } from './whatsapp';
import { notificationSpace, notificationsInboxHref } from './destinations';
import {
  normalizeNotificationPreferences,
  selectedNotificationChannels,
  type NotificationPreferences,
  type NotificationUrgency,
} from './preferences';
import {
  enqueueNotificationDelivery,
  listDueNotificationDeliveries,
  markNotificationFailed,
  markNotificationSent,
  type NotificationOutboxItem,
  type OutboxChannel,
} from './outbox';
import {
  renderEmailNotification,
  renderPushNotification,
  resolveNotificationTemplateId,
} from './templates';
import { isOutboundProcessingBlocked, isPrivacyOperationalNotice } from '@/lib/privacy/catalog';

type Queryable = DataSource | EntityManager;

export interface NotificationInput {
  type: string;
  title: string;
  message: string;
  eventType?: string | null;
  eventId?: string | null;
  urgency?: NotificationUrgency;
}

async function getUserNotificationPreferences(db: DataSource, userId: number): Promise<NotificationPreferences> {
  const record = await getPlanningRecord(db, `notification-preferences:${userId}`);
  return normalizeNotificationPreferences(record?.payload);
}

/**
 * Destination opaque d'un canal externe (issue #27) : jamais l'URL résolue de
 * l'événement, seulement un pointeur vers la notification in-app — les détails ne
 * sont rechargés qu'après authentification et contrôle tenant/objet, via
 * `/api/notifications/[id]/open` (`route.ts`).
 */
function opaqueNotificationHref(user: UserEntity, notificationId: number | null): string {
  if (notificationId !== null) return `/api/notifications/${notificationId}/open`;
  return notificationsInboxHref(notificationSpace(normalizeAccessRole(user.accessRole)));
}

async function deliverWhatsApp(db: DataSource, user: UserEntity, templateId: ReturnType<typeof resolveNotificationTemplateId>): Promise<void> {
  if (!isWhatsAppGloballyEnabled()) return;
  const preferences = await getUserNotificationPreferences(db, user.id);
  if (!preferences.whatsapp) return;
  const phone = user.telephone?.trim() || null;
  if (!phone) return;
  await sendWhatsAppNotification({ to: phone, templateId });
}

async function deliverChannel(db: DataSource, user: UserEntity, channel: OutboxChannel, item: NotificationOutboxItem): Promise<void> {
  if (channel === 'push') {
    throw new Error('Push delivery requires an outbox delivery identifier');
  }
  if (channel === 'email') {
    if (!user.email) return;
    const preferences = await getUserNotificationPreferences(db, user.id);
    const rendered = renderEmailNotification(item.templateId, { detailed: preferences.emailDetailedPreview });
    await sendEmail({ to: user.email, subject: rendered.subject, text: rendered.body, clubId: user.clubId });
    return;
  }
  return deliverWhatsApp(db, user, item.templateId);
}

async function deliverOutboxItem(db: DataSource, user: UserEntity, item: NotificationOutboxItem): Promise<void> {
  try {
    if (item.channel === 'push') {
      const preferences = await getUserNotificationPreferences(db, user.id);
      const rendered = renderPushNotification(item.templateId, { detailed: preferences.pushDetailedPreview });
      await triggerPushForUser(db, user.id, {
        notificationId: item.notificationId,
        templateId: item.templateId,
        title: rendered.title,
        message: rendered.body,
        clubId: user.clubId,
        url: opaqueNotificationHref(user, item.notificationId),
      });
    } else {
      await deliverChannel(db, user, item.channel, item);
    }
    await markNotificationSent(db, item.id);
  } catch (error) {
    await markNotificationFailed(db, item.id, item.attempts, error);
  }
}

/**
 * Calcule les canaux sélectionnés pour cet utilisateur et persiste l'intention de
 * notification correspondante : la ligne in-app (le cas échéant) et une ligne d'outbox
 * par canal différé (push/email/whatsapp) — sans jamais tenter la livraison réseau
 * elle-même (issue #276 : « Sending email/push inside the database transaction » est un
 * non-but explicite). `db` peut être un `EntityManager` transactionnel : appelée depuis
 * une transaction métier (ex. publication globale), cette étape devient atomique avec
 * elle — soit la commande et ses intentions de notification sont toutes deux actées,
 * soit aucune ne l'est. `idempotencyKeyBase` (propre à l'appelant) identifie le
 * changement notifié, indépendamment de l'instant de l'appel : deux tentatives portant
 * la même base convergent sur les mêmes lignes d'outbox au lieu de les doubler.
 */
async function enqueueChannelsForUser(
  db: Queryable,
  user: UserEntity,
  input: NotificationInput,
  idempotencyKeyBase?: string,
): Promise<NotificationOutboxItem[]> {
  const restricted = isOutboundProcessingBlocked(user);
  const operationalNotice = isPrivacyOperationalNotice(input.type);
  if (restricted && !operationalNotice) {
    return [];
  }

  const preferenceRecord = await getPlanningRecord(db, `notification-preferences:${user.id}`);
  const preferences = normalizeNotificationPreferences(preferenceRecord?.payload);
  const selected = selectedNotificationChannels(preferences, { urgency: input.urgency, eventType: input.eventType });
  // Gabarit allowlisté résolu une fois, depuis la catégorie du type métier — jamais depuis
  // le titre/message libre, qui ne quitte plus l'in-app (issue #27).
  const templateId = resolveNotificationTemplateId(input.type);

  // Identifiant opaque de la ligne in-app : seule source du détail réel, résolue après
  // authentification + contrôle tenant/objet (`/api/notifications/[id]/open`). Les canaux
  // externes ne référencent jamais que cet identifiant.
  let notificationId: number | null = null;
  if (selected.includes('inApp')) {
    try {
      const repo = db.getRepository<NotificationEntity>('Notification');
      const saved = await repo.save({
        userId: user.id,
        type: input.type,
        title: input.title,
        message: input.message,
        eventType: input.eventType ?? null,
        eventId: input.eventId ?? null,
        readAt: null,
      });
      notificationId = saved?.id ?? null;
      if (!(CHAT_INBOX_EXCLUDED_TYPES as readonly string[]).includes(input.type)) {
        emitNotificationsChanged(user.clubId, user.id);
      }
    } catch (error) {
      logError('app.unhandled', error);
    }
  }

  const channels: OutboxChannel[] = ['push', 'email', 'whatsapp'];
  const items: NotificationOutboxItem[] = [];
  for (const channel of channels) {
    if (!selected.includes(channel)) continue;
    if (channel === 'email' && !user.email) continue;
    if (channel === 'whatsapp' && (!isWhatsAppGloballyEnabled() || !user.telephone?.trim())) continue;
    try {
      const item = await enqueueNotificationDelivery(
        db,
        {
          userId: user.id,
          channel,
          templateId,
          notificationId,
        },
        idempotencyKeyBase ? `${idempotencyKeyBase}:${channel}` : undefined,
      );
      items.push(item);
    } catch (error) {
      logError('app.unhandled', error);
    }
  }
  return items;
}

export interface EnqueuedContactNotification {
  user: UserEntity;
  items: NotificationOutboxItem[];
}

/**
 * Variante transactionnelle de `createNotificationForUser`, pour un destinataire déjà
 * connu (issue #285 : décisions d'échange d'affectation) — persiste l'intention sans
 * livrer, dans le même format que `enqueueContactNotificationIntents` pour composer
 * avec `deliverEnqueuedNotifications` après le commit.
 */
export async function enqueueUserNotificationIntents(
  db: Queryable,
  user: UserEntity,
  input: NotificationInput,
  idempotencyKeyBase?: string,
): Promise<EnqueuedContactNotification[]> {
  const items = await enqueueChannelsForUser(db, user, input, idempotencyKeyBase);
  return [{ user, items }];
}

/**
 * Variante transactionnelle de `notifyAdmins` (issue #285), même usage que
 * `enqueueUserNotificationIntents` — un club sans administrateur actif renvoie une liste vide.
 */
export async function enqueueAdminNotificationIntents(
  db: Queryable,
  input: NotificationInput,
  idempotencyKeyBase?: string,
): Promise<EnqueuedContactNotification[]> {
  const activeUsers = await db.getRepository<UserEntity>('User').find({ where: { active: true, clubId: getCurrentClubId() } });
  const admins = activeUsers.filter((user) => user.accessRole === 'admin');
  const enqueued: EnqueuedContactNotification[] = [];
  for (const admin of admins) {
    const items = await enqueueChannelsForUser(
      db,
      admin,
      input,
      idempotencyKeyBase ? `${idempotencyKeyBase}:${admin.id}` : undefined,
    );
    enqueued.push({ user: admin, items });
  }
  return enqueued;
}

/**
 * Variante transactionnelle de `notifyContact` (issue #276) : persiste les intentions de
 * notification (ligne in-app + lignes d'outbox par canal) pour chaque compte correspondant
 * au contact, sans livrer quoi que ce soit — à appeler avec le `manager` d'une transaction
 * métier en cours. La livraison réelle (réseau) est différée après le commit via
 * `deliverEnqueuedNotifications`, avec le résultat de cet appel.
 */
export async function enqueueContactNotificationIntents(
  db: Queryable,
  contact: AssignmentContact,
  input: NotificationInput,
  idempotencyKeyBase?: string,
): Promise<EnqueuedContactNotification[]> {
  const users = await findUsersForContact(db, contact);
  const enqueued: EnqueuedContactNotification[] = [];
  for (const user of users) {
    const items = await enqueueChannelsForUser(
      db,
      user,
      input,
      idempotencyKeyBase ? `${idempotencyKeyBase}:${user.id}` : undefined,
    );
    enqueued.push({ user, items });
  }
  return enqueued;
}

/**
 * Livre après coup (issue #276) les intentions déjà persistées par
 * `enqueueContactNotificationIntents` — jamais dans la transaction qui les a créées.
 * Un échec de livraison reste isolé par canal (`deliverOutboxItem`) et rejouable via
 * l'outbox existant (`retryPendingNotifications`) : il ne fait jamais échouer l'appelant.
 */
export async function deliverEnqueuedNotifications(
  db: DataSource,
  enqueued: EnqueuedContactNotification[],
): Promise<void> {
  await Promise.all(
    enqueued.flatMap(({ user, items }) => items.map((item) => deliverOutboxItem(db, user, item))),
  );
}

/**
 * Une notification est toujours un effet secondaire d'une commande métier déjà enregistrée
 * (affectation, publication, échange…) : son échec ne doit jamais remonter comme une erreur
 * de la commande principale, sous peine de faire croire à un client qu'une opération réussie
 * a échoué (issue #208). Chaque canal est donc isolé et son échec seulement journalisé — les
 * canaux différés (push/email/whatsapp) restent de toute façon rejouables via l'outbox
 * (`retryPendingNotifications`), qui gère déjà leurs échecs indépendamment de cette fonction.
 */
export async function createNotificationForUser(
  db: DataSource,
  user: UserEntity,
  input: NotificationInput,
): Promise<void> {
  try {
    const items = await enqueueChannelsForUser(db, user, input);
    await Promise.all(items.map((item) => deliverOutboxItem(db, user, item)));
  } catch (error) {
    logError('app.unhandled', error);
  }
}

export async function retryPendingNotifications(db: DataSource, limit = 100): Promise<{ processed: number }> {
  const items = await listDueNotificationDeliveries(db, limit);
  const userRepo = db.getRepository<UserEntity>('User');
  for (const item of items) {
    const user = await userRepo.findOneBy({ id: item.userId });
    if (!user || !user.active) {
      await markNotificationFailed(db, item.id, 9, new Error('Utilisateur introuvable ou inactif'));
      continue;
    }
    // Un club désactivé (issue #215) coupe immédiatement ses notifications en attente,
    // y compris celles déjà en file suite à un échec temporaire : on les abandonne (attempts=9
    // force le statut "dead", cf. markNotificationFailed) plutôt que de les retenter indéfiniment.
    if (!(await isClubTenantActive(db, user.clubId))) {
      await markNotificationFailed(db, item.id, 9, new Error('Club désactivé'));
      continue;
    }
    await deliverOutboxItem(db, user, item);
  }
  return { processed: items.length };
}

export async function notifyAdmins(db: DataSource, input: NotificationInput): Promise<void> {
  const activeUsers = await db.getRepository<UserEntity>('User').find({ where: { active: true, clubId: getCurrentClubId() } });
  const admins = activeUsers.filter((user) => user.accessRole === 'admin');
  await Promise.all(admins.map((user) => createNotificationForUser(db, user, input)));
}

export async function findUsersForContact(db: Queryable, contact: AssignmentContact): Promise<UserEntity[]> {
  const activeUsers = await db.getRepository<UserEntity>('User').find({ where: { active: true, clubId: getCurrentClubId() } });

  if (contact.personId !== undefined && contact.personType) {
    return activeUsers.filter((user) => user.id === contact.personId);
  }

  const name = contact.nom.trim().toLowerCase();
  if (!name) return [];
  return activeUsers.filter((user) => user.nom.trim().toLowerCase() === name);
}

export async function notifyContact(db: DataSource, contact: AssignmentContact, input: NotificationInput): Promise<void> {
  const users = await findUsersForContact(db, contact);
  await Promise.all(users.map((user) => createNotificationForUser(db, user, input)));
}
