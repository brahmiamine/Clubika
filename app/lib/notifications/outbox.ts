import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { serializeOutboxError } from '@/lib/observability/redact';
import type { NotificationUrgency } from './preferences';

type Queryable = DataSource | EntityManager;

export type OutboxChannel = 'push' | 'email' | 'whatsapp';

export interface NotificationOutboxItem {
  id: string;
  userId: number;
  channel: OutboxChannel;
  type: string;
  title: string;
  message: string;
  eventType: string | null;
  eventId: string | null;
  urgency: NotificationUrgency;
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
      (id, user_id, channel, notification_type, title, message, event_type, event_id, urgency, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE id = id`,
    [item.id, item.userId, item.channel, item.type, item.title, item.message, item.eventType, item.eventId, item.urgency, idempotencyKey ?? null],
  );
  if (!idempotencyKey) return item;
  const rows = (await db.query(
    `SELECT id, user_id AS userId, channel, notification_type AS type, title, message,
            event_type AS eventType, event_id AS eventId, urgency, attempts
       FROM planning_notification_outbox WHERE idempotency_key = ? LIMIT 1`,
    [idempotencyKey],
  )) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return item;
  return {
    id: String(row.id),
    userId: Number(row.userId),
    channel: row.channel as OutboxChannel,
    type: String(row.type),
    title: String(row.title),
    message: String(row.message),
    eventType: row.eventType === null || row.eventType === undefined ? null : String(row.eventType),
    eventId: row.eventId === null || row.eventId === undefined ? null : String(row.eventId),
    urgency: row.urgency as NotificationUrgency,
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
      `SELECT id, user_id AS userId, channel, notification_type AS type, title, message,
         event_type AS eventType, event_id AS eventId, urgency, attempts
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
    type: String(row.type),
    title: String(row.title),
    message: String(row.message),
    eventType: row.eventType === null ? null : String(row.eventType),
    eventId: row.eventId === null ? null : String(row.eventId),
    urgency: row.urgency as NotificationUrgency,
    attempts: Number(row.attempts),
  }));
}
