import { createHash } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

type Queryable = DataSource | EntityManager;

export interface BrowserPushSubscription {
  endpoint: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
}

export interface StoredPushSubscription {
  endpoint: string;
  endpointHash: string;
  p256dh: string | null;
  auth: string | null;
}

function hashEndpoint(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex');
}

export async function savePushSubscription(
  db: Queryable,
  userId: number,
  subscription: BrowserPushSubscription,
  userAgent: string | null,
): Promise<void> {
  const endpointHash = hashEndpoint(subscription.endpoint);

  await db.query(
    `
      INSERT INTO push_subscriptions
        (user_id, endpoint_hash, endpoint, p256dh, auth_secret, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        user_id = VALUES(user_id),
        endpoint = VALUES(endpoint),
        p256dh = VALUES(p256dh),
        auth_secret = VALUES(auth_secret),
        user_agent = VALUES(user_agent),
        updated_at = CURRENT_TIMESTAMP(6)
    `,
    [
      userId,
      endpointHash,
      subscription.endpoint,
      subscription.keys?.p256dh ?? null,
      subscription.keys?.auth ?? null,
      userAgent,
    ],
  );
}

export async function removePushSubscription(
  db: Queryable,
  userId: number,
  endpoint: string,
): Promise<void> {
  await db.query('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint_hash = ?', [
    userId,
    hashEndpoint(endpoint),
  ]);
}

export async function removePushSubscriptionByEndpoint(
  db: Queryable,
  endpoint: string,
): Promise<void> {
  await db.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ?', [hashEndpoint(endpoint)]);
}

export async function removeAllPushSubscriptionsForUser(
  db: Queryable,
  userId: number,
): Promise<void> {
  await db.query('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
}

export async function listPushSubscriptionsForUser(
  db: DataSource,
  userId: number,
): Promise<StoredPushSubscription[]> {
  const rows = (await db.query(
    `SELECT endpoint, endpoint_hash AS endpointHash, p256dh, auth_secret AS auth
     FROM push_subscriptions WHERE user_id = ?`,
    [userId],
  )) as StoredPushSubscription[];

  return rows;
}
