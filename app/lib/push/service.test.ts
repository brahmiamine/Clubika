import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(async (..._args: unknown[]) => ({ statusCode: 201 })),
  removePushSubscriptionByEndpoint: vi.fn(async (..._args: unknown[]) => undefined),
  listPushSubscriptionsForUser: vi.fn(async (..._args: unknown[]) => [{
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-subscription',
    endpointHash: 'hash',
    p256dh: 'public-key',
    auth: 'auth-secret',
  }]),
}));

vi.mock('web-push', () => ({ default: { sendNotification: mocks.sendNotification } }));
vi.mock('./vapid', () => ({
  buildVapidAuthorization: vi.fn(),
  getVapidConfig: () => ({ publicKey: 'vapid-public', privateKey: 'vapid-private', subject: 'mailto:test@example.com' }),
}));
vi.mock('./store', () => ({
  listPushSubscriptionsForUser: mocks.listPushSubscriptionsForUser,
  removePushSubscriptionByEndpoint: mocks.removePushSubscriptionByEndpoint,
}));

import { triggerPushForUser, type PushNotificationPayload } from './service';

const db = {} as DataSource;

function payload(notificationId: string): PushNotificationPayload {
  return {
    notificationId,
    type: 'assignment',
    title: `Notification ${notificationId}`,
    message: `Message ${notificationId}`,
    eventType: 'amical',
    eventId: 'match-1',
    url: '/notifications',
    clubId: 'us-biotoise',
  };
}

describe('triggerPushForUser (issue #219)', () => {
  beforeEach(() => {
    vi.stubEnv('WEB_PUSH_ENABLED', 'true');
    mocks.sendNotification.mockClear();
    mocks.removePushSubscriptionByEndpoint.mockClear();
  });

  it('encrypts and sends the correlated payload for every notification', async () => {
    await triggerPushForUser(db, 7, payload('delivery-1'));
    await triggerPushForUser(db, 7, payload('delivery-2'));

    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    expect(mocks.sendNotification.mock.calls.map((call) => JSON.parse(String(call[1])).notificationId)).toEqual([
      'delivery-1',
      'delivery-2',
    ]);
    expect(JSON.parse(String(mocks.sendNotification.mock.calls[0]?.[1])).icon).toBe(
      '/api/pwa/icon?clubId=us-biotoise&size=192&variant=plain',
    );
    expect(JSON.parse(String(mocks.sendNotification.mock.calls[0]?.[1])).badge).toBe(
      '/pwa/icon-192.png',
    );
    expect(mocks.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://fcm.googleapis.com/fcm/send/test-subscription',
        keys: { p256dh: 'public-key', auth: 'auth-secret' },
      }),
      expect.any(String),
      expect.objectContaining({
        TTL: 86_400,
        urgency: 'high',
        vapidDetails: expect.objectContaining({ subject: 'mailto:test@example.com' }),
      }),
    );
  });
});
