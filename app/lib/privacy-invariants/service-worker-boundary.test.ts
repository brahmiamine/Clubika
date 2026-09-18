/**
 * Frontière : service worker (issue #41 / #219).
 *
 * Le service worker tourne côté client, hors de toute base de données : un
 * payload de notification push peut légitimement transporter des champs que
 * l'on ne veut *jamais* voir apparaître dans une notification système, un
 * `postMessage`, ou un `console.error` de décodage (rawText, secret, endpoint
 * d'un tiers). Ce fichier réutilise le même harnais que `public/sw.test.ts`
 * (chargement du script réel dans un contexte `vm`, pas de réimplémentation du
 * service worker) et y ajoute une frontière négative avec des champs
 * sentinelles inattendus.
 */
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { allForbiddenNeedles, forbiddenSentinelBundle } from './sentinel-factory';

type PushListener = (event: {
  data?: { json: () => unknown };
  waitUntil: (promise: Promise<void>) => void;
}) => void;

function loadServiceWorker(self: Record<string, unknown>) {
  const source = readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8');
  runInNewContext(source, { self, fetch: self.fetch ?? vi.fn(), console, URL });
  const listeners = self.__listeners as Map<string, PushListener>;
  return { push: listeners.get('push') };
}

function createSelf(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, PushListener>();
  const consoleSpy = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
  return {
    location: { origin: 'https://club.example' },
    addEventListener: (name: string, listener: PushListener) => listeners.set(name, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(), matchAll: vi.fn(async () => []), openWindow: vi.fn() },
    registration: { showNotification: vi.fn(async () => undefined) },
    fetch: vi.fn(),
    __listeners: listeners,
    __consoleSpy: consoleSpy,
    ...overrides,
  };
}

describe('frontière: service worker — push (issue #41)', () => {
  it('ne propage jamais un champ hors allowlist (rawText, secret, endpoint tiers) vers la notification système', async () => {
    const bundle = forbiddenSentinelBundle('sw-push');
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
          notificationId: 'sw-delivery-1',
          type: 'assignment',
          title: 'Nouvelle notification',
          message: 'Vous avez une nouvelle affectation.',
          eventType: 'amical',
          eventId: 'match-1',
          url: '/club/notifications',
          // Champs qui ne doivent jamais apparaître dans une notification système :
          rawText: bundle.rawText,
          name: bundle.name,
          email: bundle.email,
          phone: bundle.phone,
          token: bundle.token,
          secret: bundle.secret,
          ip: bundle.ip,
          endpoint: bundle.pushEndpoint,
        }),
      },
      waitUntil: (promise) => pending.push(promise),
    });
    await Promise.all(pending);

    expect((self as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
    const notificationCall = (self.registration as { showNotification: ReturnType<typeof vi.fn> }).showNotification.mock.calls[0];
    const postMessageCall = postMessage.mock.calls[0]?.[0];

    for (const needle of allForbiddenNeedles(bundle)) {
      expect(JSON.stringify(notificationCall)).not.toContain(needle);
      expect(JSON.stringify(postMessageCall)).not.toContain(needle);
    }
  });
});
