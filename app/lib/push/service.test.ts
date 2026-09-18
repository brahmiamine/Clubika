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

function payload(notificationId: number): PushNotificationPayload {
  return {
    notificationId,
    templateId: 'planning',
    title: 'Clubika',
    message: 'Une mise à jour de planning vous concerne. Ouvrez l’application pour la consulter.',
    url: `/api/notifications/${notificationId}/open`,
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
    await triggerPushForUser(db, 7, payload(101));
    await triggerPushForUser(db, 7, payload(102));

    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);
    expect(mocks.sendNotification.mock.calls.map((call) => JSON.parse(String(call[1])).notificationId)).toEqual([
      101,
      102,
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

  it('never transmits an event identifier — only the opaque notification id and the resolver URL (issue #27)', async () => {
    await triggerPushForUser(db, 7, payload(101));

    const sent = JSON.parse(String(mocks.sendNotification.mock.calls[0]?.[1])) as Record<string, unknown>;
    expect(sent).not.toHaveProperty('eventType');
    expect(sent).not.toHaveProperty('eventId');
    expect(sent.url).toBe('/api/notifications/101/open');
  });
});
