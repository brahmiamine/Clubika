import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type SwListener = (event: {
  data?: { json: () => unknown };
  notification?: { close: () => void; data?: { url?: string } };
  waitUntil: (promise: Promise<void>) => void;
}) => void;

function loadServiceWorker(self: Record<string, unknown>) {
  const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
  runInNewContext(source, { self, fetch: self.fetch ?? vi.fn(), console, URL, caches: self.caches, Date });
  const listeners = self.__listeners as Map<string, SwListener>;
  return {
    push: listeners.get('push'),
    click: listeners.get('notificationclick'),
    activate: listeners.get('activate'),
  };
}

function createSelf(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, SwListener>();
  return {
    location: { origin: 'https://club.example' },
    addEventListener: (name: string, listener: SwListener) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    registration: { showNotification: vi.fn(async (..._args: unknown[]) => undefined) },
    caches: { keys: vi.fn(async () => []), delete: vi.fn(async () => true), open: vi.fn(async () => ({ add: vi.fn(), put: vi.fn() })) },
    fetch: vi.fn(),
    __listeners: listeners,
    ...overrides,
  };
}

describe('service worker installability', () => {
  it('registers a fetch handler required for Android WebAPK install', () => {
    const source = readFileSync(new URL('./sw.js', import.meta.url), 'utf8');
    expect(source).toContain("addEventListener('fetch'");
    expect(source).toContain('event.respondWith');
    expect(source).toContain("const OFFLINE_URL = '/offline'");
    expect(source).toContain("if (event.request.method !== 'GET') return");
    expect(source).toContain("url.pathname.startsWith('/inscription/')");
    expect(source).toContain("url.pathname.startsWith('/api/invitations/')");
  });
});

describe('service worker push correlation (issue #219)', () => {
  it('shows two distinct system notifications for two close push payloads', async () => {
    const self = createSelf();
    const { push } = loadServiceWorker(self);
    if (!push) throw new Error('push listener missing');

    const pending: Promise<void>[] = [];
    const dispatch = (notificationId: string, title: string) => push({
      data: {
        json: () => ({
          notificationId,
          type: 'assignment',
          title,
          message: `Message ${notificationId}`,
          eventType: 'amical',
          eventId: 'match-1',
          url: '/club/notifications',
        }),
      },
      waitUntil: (promise) => pending.push(promise),
    });

    dispatch('delivery-1', 'Première');
    dispatch('delivery-2', 'Deuxième');
    await Promise.all(pending);

    expect(self.fetch).not.toHaveBeenCalled();
    expect(self.registration.showNotification).toHaveBeenCalledTimes(2);
    expect((self.registration.showNotification as ReturnType<typeof vi.fn>).mock.calls.map(([, options]) => (options as { tag: string }).tag)).toEqual([
      'notification:delivery-1',
      'notification:delivery-2',
    ]);
  });

  it('puts the Clubika C on the left (badge) and the club logo on the right (icon)', async () => {
    const self = createSelf();
    const { push } = loadServiceWorker(self);
    if (!push) throw new Error('push listener missing');

    const pending: Promise<void>[] = [];
    push({
      data: {
        json: () => ({
          notificationId: 'delivery-3',
          type: 'assignment',
          title: 'Message de test1',
          message: 'nn',
          eventType: 'amical',
          eventId: 'match-1',
          url: '/club/notifications',
          clubId: 'us-biotoise',
          icon: '/api/pwa/icon?clubId=us-biotoise&size=192&variant=plain',
        }),
      },
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);

    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    const options = (self.registration.showNotification as ReturnType<typeof vi.fn>).mock.calls.map(([, opts]) => opts)[0] as {
      icon: string;
      image?: string;
      badge?: string;
      silent?: boolean;
      vibrate?: number[];
    };
    expect(options.icon).toBe('https://club.example/api/pwa/icon?clubId=us-biotoise&size=192&variant=plain');
    expect(options.badge).toBe('https://club.example/pwa/icon-192.png');
    expect(options.image).toBeUndefined();
    expect(options.silent).toBe(false);
    expect(options.vibrate).toEqual([200, 100, 200]);
    expect(options.icon).not.toContain('/branding/');
  });

  it('relays a heads-up payload to a visible app and still shows the system notification', async () => {
    const postMessage = vi.fn();
    const self = createSelf({
      clients: {
        claim: vi.fn(),
        matchAll: vi.fn(async () => [{ visibilityState: 'visible', postMessage }]),
        openWindow: vi.fn(),
      },
    });
    const { push } = loadServiceWorker(self);
    if (!push) throw new Error('push listener missing');

    const pending: Promise<void>[] = [];
    push({
      data: {
        json: () => ({
          notificationId: 'delivery-visible',
          type: 'chat-dm',
          title: 'Message de Alice',
          message: 'Salut',
          eventType: 'chat',
          eventId: 'room-1',
          url: '/club/chat?roomId=room-1',
          clubId: 'us-biotoise',
        }),
      },
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);

    expect(self.registration.showNotification).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'incoming-notification',
      title: 'Message de Alice',
      body: 'Salut',
    }));
  });

  it('stores an absolute navigation URL and opens it on notification click', async () => {
    const postMessage = vi.fn();
    const navigate = vi.fn(async () => undefined);
    const focus = vi.fn(async () => undefined);
    const openWindow = vi.fn(async () => undefined);
    const self = createSelf({
      clients: {
        claim: vi.fn(),
        matchAll: vi.fn(async () => [{ url: 'https://club.example/club', postMessage, navigate, focus }]),
        openWindow,
      },
    });
    const { push, click } = loadServiceWorker(self);
    if (!push || !click) throw new Error('service worker listeners missing');

    const pending: Promise<void>[] = [];
    push({
      data: {
        json: () => ({
          notificationId: 'delivery-4',
          type: 'chat-dm',
          title: 'Message',
          message: 'Salut',
          eventType: 'chat',
          eventId: 'room-1',
          url: '/club/chat?roomId=room-1',
        }),
      },
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);

    const options = (self.registration.showNotification as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as { data: { url: string } };
    expect(options.data.url).toBe('https://club.example/club/chat?roomId=room-1');

    const clickPending: Promise<void>[] = [];
    click({
      notification: {
        close: vi.fn(),
        data: options.data,
      },
      waitUntil: (promise) => clickPending.push(promise),
    });
    await Promise.all(clickPending);

    expect(navigate).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification-navigate',
      url: 'https://club.example/club/chat?roomId=room-1',
    });
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('opens a new window on the destination when the app is closed', async () => {
    const openWindow = vi.fn(async () => undefined);
    const self = createSelf({
      clients: {
        claim: vi.fn(),
        matchAll: vi.fn(async () => []),
        openWindow,
      },
    });
    const { click } = loadServiceWorker(self);
    if (!click) throw new Error('notificationclick listener missing');

    const clickPending: Promise<void>[] = [];
    click({
      notification: {
        close: vi.fn(),
        data: { url: 'https://club.example/mon-planning/evenements/officiel/m-1' },
      },
      waitUntil: (promise) => clickPending.push(promise),
    });
    await Promise.all(clickPending);

    expect(openWindow).toHaveBeenCalledWith('https://club.example/mon-planning/evenements/officiel/m-1');
  });

  it('navigates via postMessage when WindowClient.navigate is missing (iOS / WebAPK)', async () => {
    const postMessage = vi.fn();
    const focus = vi.fn(async () => undefined);
    const openWindow = vi.fn(async () => undefined);
    const self = createSelf({
      clients: {
        claim: vi.fn(),
        matchAll: vi.fn(async () => [{
          url: 'https://club.example/club',
          postMessage,
          focus,
        }]),
        openWindow,
      },
    });
    const { click } = loadServiceWorker(self);
    if (!click) throw new Error('notificationclick listener missing');

    const clickPending: Promise<void>[] = [];
    click({
      notification: {
        close: vi.fn(),
        data: { url: 'https://club.example/club/notifications' },
      },
      waitUntil: (promise) => clickPending.push(promise),
    });
    await Promise.all(clickPending);

    expect(postMessage).toHaveBeenCalledWith({
      type: 'notification-navigate',
      url: 'https://club.example/club/notifications',
    });
    expect(focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });
});
