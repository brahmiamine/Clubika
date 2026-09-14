import { logError } from '@/lib/observability/log';
import { buildNotificationClubIconPath, PWA_NOTIFICATION_ICON } from '@/lib/pwa/icons';
import type { DataSource } from 'typeorm';
import webPush from 'web-push';
import { buildVapidAuthorization, getVapidConfig } from './vapid';
import {
  listPushSubscriptionsForUser,
  removePushSubscriptionByEndpoint,
  type StoredPushSubscription,
} from './store';

const DEFAULT_PUSH_TTL_SECONDS = 60 * 60 * 24;

async function sendWakeUpPush(endpoint: string): Promise<Response> {
  const config = getVapidConfig();
  if (!config) {
    throw new Error('VAPID configuration is missing');
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: buildVapidAuthorization(endpoint, config),
      TTL: String(DEFAULT_PUSH_TTL_SECONDS),
      Urgency: 'high',
    },
  });
}

export interface PushNotificationPayload {
  notificationId: string;
  type: string;
  title: string;
  message: string;
  eventType: string | null;
  eventId: string | null;
  url?: string;
  clubId?: string;
  icon?: string;
  badge?: string;
}

function withNotificationIcon(payload: PushNotificationPayload): PushNotificationPayload {
  return {
    ...payload,
    icon: buildNotificationClubIconPath(payload.clubId),
    badge: PWA_NOTIFICATION_ICON,
  };
}

async function sendPayloadPush(
  subscription: StoredPushSubscription,
  payload: PushNotificationPayload,
): Promise<void> {
  const config = getVapidConfig();
  if (!config) throw new Error('VAPID configuration is missing');
  if (!subscription.p256dh || !subscription.auth) {
    const response = await sendWakeUpPush(subscription.endpoint);
    if (!response.ok) {
      const error = new Error(`Web push failed with status ${response.status}`) as Error & { statusCode?: number };
      error.statusCode = response.status;
      throw error;
    }
    return;
  }

  await webPush.sendNotification(
    {
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    },
    JSON.stringify(withNotificationIcon(payload)),
    {
      TTL: DEFAULT_PUSH_TTL_SECONDS,
      urgency: 'high',
      vapidDetails: {
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      },
    },
  );
}

function pushStatusCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('statusCode' in error)) return null;
  const status = Number((error as { statusCode?: unknown }).statusCode);
  return Number.isInteger(status) ? status : null;
}

export async function triggerPushForUser(
  db: DataSource,
  userId: number,
  payload: PushNotificationPayload,
): Promise<void> {
  if (!getVapidConfig()) return;

  try {
    const subscriptions = await listPushSubscriptionsForUser(db, userId);

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await sendPayloadPush(subscription, payload);
        } catch (error) {
          const status = pushStatusCode(error);
          if (status === 404 || status === 410) {
            await removePushSubscriptionByEndpoint(db, subscription.endpoint);
            return;
          }
          logError('push.delivery_failed', error);
        }
      }),
    );
  } catch (error) {
    logError('push.delivery_failed', error);
  }
}
