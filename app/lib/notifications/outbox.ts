import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { serializeOutboxError } from '@/lib/observability/redact';
import type { NotificationTemplateId } from './templates';

type Queryable = DataSource | EntityManager;

export type OutboxChannel = 'push' | 'email' | 'whatsapp';

/**
 * L'outbox ne conserve plus que ce qui est strictement nécessaire pour livrer et
 * rejouer un envoi (issue #27) : un identifiant de gabarit allowlisté (`templateId`,
 * jamais de texte libre) et des identifiants opaques (`id` de la ligne, `notificationId`
 * qui pointe vers la notification in-app — seule source du détail réel, résolue après
 * authentification + contrôle tenant/objet par `/api/notifications/[id]/open`). Plus de
 * `title`/`message`/`eventType`/`eventId` en clair dans cette table (migration `0041`).
 */
export interface NotificationOutboxItem {
  id: string;
  userId: number;
  channel: OutboxChannel;
  templateId: NotificationTemplateId;
  /** Identifiant opaque de la notification in-app correspondante (table `notifications`), le cas échéant. */
  notificationId: number | null;
  attempts: number;
}

/**
 * Empreinte d'idempotence (issue #276) : deux appels portant la même clé (par ex. deux
 * publications concurrentes parties du même état publié précédent) convergent sur une
 * seule ligne d'outbox au lieu de doubler la notification — `ON DUPLICATE KEY UPDATE`
 * ne modifie rien, puis la ligne existante est relue pour renvoyer son identifiant
 * réel. Omise (undefined), un enregistrement est toujours créé (comportement des
 * appelants hors publication, inchangé).
 */
export async function enqueueNotificationDelivery(
  db: Queryable,
  input: Omit<NotificationOutboxItem, 'id' | 'attempts'>,
  idempotencyKey?: string,
): Promise<NotificationOutboxItem> {
  const item: NotificationOutboxItem = { ...input, id: randomUUID(), attempts: 0 };
  await db.query(
    `INSERT INTO planning_notification_outbox
      (id, user_id, channel, template_id, notification_id, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [item.id, item.userId, item.channel, item.templateId, item.notificationId, idempotencyKey ?? null],
  );
  if (!idempotencyKey) return item;
  const rows = (await db.query(
    `SELECT id, user_id AS userId, channel, template_id AS templateId, notification_id AS notificationId, attempts
       FROM planning_notification_outbox WHERE idempotency_key = ? LIMIT 1`,
    [idempotencyKey],
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return item;
  return {
    id: String(row.id),
    userId: Number(row.userId),
    channel: row.channel as OutboxChannel,
    templateId: row.templateId as NotificationTemplateId,
    notificationId: row.notificationId === null || row.notificationId === undefined ? null : Number(row.notificationId),
    attempts: Number(row.attempts),
  };
}

export async function markNotificationSent(db: DataSource, id: string): Promise<void> {
  await db.query(
    `UPDATE planning_notification_outbox
     SET status = 'sent', attempts = attempts + 1, sent_at = CURRENT_TIMESTAMP(6), last_error = NULL
     WHERE id = ?`,
    [id],
  );
}

export async function markNotificationFailed(db: DataSource, id: string, attempts: number, error: unknown): Promise<void> {
  const stored = serializeOutboxError(error);
  const delayMinutes = Math.min(360, 2 ** Math.min(attempts, 8));
  await db.query(
    `UPDATE planning_notification_outbox
     SET status = CASE WHEN attempts + 1 >= 10 THEN 'dead' ELSE 'pending' END,
         attempts = attempts + 1,
         next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL ? MINUTE),
         last_error = ?
     WHERE id = ?`,
    [delayMinutes, stored, id],
  );
}

export async function listDueNotificationDeliveries(db: DataSource, limit = 100): Promise<NotificationOutboxItem[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = await db.transaction(async (manager) => {
    await manager.query(
      `UPDATE planning_notification_outbox SET status = 'pending'
       WHERE status = 'processing' AND next_attempt_at <= CURRENT_TIMESTAMP(6)`,
    );
    const claimed = await manager.query(
      `SELECT id, user_id AS userId, channel, template_id AS templateId, notification_id AS notificationId, attempts
       FROM planning_notification_outbox
       WHERE status = 'pending' AND next_attempt_at <= CURRENT_TIMESTAMP(6)
       ORDER BY created_at ASC LIMIT ${safeLimit} FOR UPDATE`,
    ) as Array<Record<string, unknown>>;
    if (claimed.length) {
      const placeholders = claimed.map(() => '?').join(', ');
      await manager.query(
        `UPDATE planning_notification_outbox
         SET status = 'processing', next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP(6), INTERVAL 10 MINUTE)
         WHERE id IN (${placeholders})`,
        claimed.map((row) => String(row.id)),
      );
    }
    return claimed;
  });
  return rows.map((row) => ({
    id: String(row.id),
    userId: Number(row.userId),
    channel: row.channel as OutboxChannel,
    templateId: row.templateId as NotificationTemplateId,
    notificationId: row.notificationId === null || row.notificationId === undefined ? null : Number(row.notificationId),
    attempts: Number(row.attempts),
  }));
}
