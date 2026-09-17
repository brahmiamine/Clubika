import { describe, expect, it, vi } from 'vitest';
import {
  canUseWebPush,
  disableWebPushSubscription,
  isEmbeddedBrowser,
  isPushServiceUnavailableError,
  subscriptionUsesVapidKey,
} from './web-push-client';

describe('web-push-client', () => {
  it('détecte les navigateurs embarqués sans service push', () => {
    expect(isEmbeddedBrowser('Mozilla/5.0 Electron/33.0.0')).toBe(true);
    expect(isEmbeddedBrowser('Mozilla/5.0 Cursor/1.0')).toBe(true);
    expect(isEmbeddedBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile')).toBe(false);
  });

  it('refuse Web Push hors contexte sécurisé ou dans un navigateur embarqué', () => {
    const mobileChrome = 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0 Mobile';
    expect(canUseWebPush(mobileChrome, true)).toBe(true);
    expect(canUseWebPush(mobileChrome, false)).toBe(false);
    expect(canUseWebPush('Mozilla/5.0 Electron/33.0.0', true)).toBe(false);
  });

  it('reconnaît l’erreur « push service not available »', () => {
    expect(isPushServiceUnavailableError(new DOMException('Registration failed - push service not available'))).toBe(true);
    expect(isPushServiceUnavailableError(new DOMException('Aborted', 'AbortError'))).toBe(false);
    expect(isPushServiceUnavailableError(new Error('Network error'))).toBe(false);
  });

  it('compare une applicationServerKey avec la clé VAPID publique', () => {
    const publicKey = Buffer.from('vapid-public-key-bytes').toString('base64url');
    const bytes = Uint8Array.from(Buffer.from(publicKey, 'base64url'));
    expect(subscriptionUsesVapidKey(bytes.buffer, publicKey)).toBe(true);
    expect(subscriptionUsesVapidKey(bytes.buffer, 'bbbb')).toBe(false);
    expect(subscriptionUsesVapidKey(null, publicKey)).toBe(false);
  });

  describe('disableWebPushSubscription (issue #27)', () => {
    it('ne jette jamais quand le navigateur ne supporte pas Web Push (environnement serveur)', async () => {
      await expect(disableWebPushSubscription()).resolves.toBeUndefined();
    });

    it('révoque la souscription navigateur puis appelle /api/push/unsubscribe avec son endpoint', async () => {
      const unsubscribe = vi.fn(async () => true);
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ success: true })));
      const getSubscription = vi.fn(async () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', unsubscribe }));
      vi.stubGlobal('fetch', fetchImpl);
      vi.stubGlobal('navigator', {
        serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription } }) },
      });
      vi.stubGlobal('window', { PushManager: class {} });

      await disableWebPushSubscription();

      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith('/api/push/unsubscribe', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }),
      }));

      vi.unstubAllGlobals();
    });
  });
});
