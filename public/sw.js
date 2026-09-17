const APP_NOTIFICATION_URL = '/club/notifications';
const CACHE_NAME = 'clubika-shell-v2';
const OFFLINE_URL = '/offline';
const PENDING_NOTIFICATION_CACHE = 'clubika-notification-nav-v1';
const PENDING_NOTIFICATION_REQUEST = '/__pending-notification-url';
/** Petite icône de notification : fichier statique, pas le blason du club (trop grand sur iOS). */
const PWA_NOTIFICATION_ICON = '/pwa/icon-192.png';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(OFFLINE_URL))
      .then(() => self.skipWaiting()),
  );
});

/** Une notification système affichée plus longtemps que cette durée est considérée obsolète. */
const STALE_NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Nettoie les notifications système obsolètes (issue #27) : au réveil du service worker
 * et avant chaque nouvel affichage, referme toute notification encore visible dont
 * l'horodatage dépasse `STALE_NOTIFICATION_MAX_AGE_MS` — jamais de contenu périmé qui
 * traîne sur l'écran verrouillé au-delà de sa pertinence.
 */
async function clearStaleNotifications() {
  if (typeof self.registration?.getNotifications !== 'function') return;
  try {
    const shown = await self.registration.getNotifications();
    const now = Date.now();
    for (const notification of shown) {
      const at = typeof notification.timestamp === 'number' ? notification.timestamp : now;
      if (now - at > STALE_NOTIFICATION_MAX_AGE_MS) notification.close();
    }
  } catch (error) {
    console.error('Unable to clear stale notifications:', error);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME && key !== PENDING_NOTIFICATION_CACHE).map((key) => caches.delete(key)),
    )).then(() => clearStaleNotifications()).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  try {
    const url = new URL(event.request.url);
    if (
      url.pathname === '/inscription'
      || url.pathname.startsWith('/inscription/')
      || url.pathname.startsWith('/api/invitations/')
    ) {
      // Ne pas intercepter : le jeton d'invitation ne doit ni être mis en cache
      // ni retransmis par le service worker (issue #34).
      return;
    }
  } catch {
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(async () => {
        const offlinePage = await caches.match(OFFLINE_URL);
        if (offlinePage) return offlinePage;

        return new Response(
          '<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><title>Hors ligne</title></head><body><p>Connexion indisponible.</p></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
        );
      }),
    );
    return;
  }

  event.respondWith(fetch(event.request));
});

self.addEventListener('push', (event) => {
  event.waitUntil(showPushNotification(event.data));
});

function assetUrl(path) {
  const origin = self.location && self.location.origin;
  if (typeof origin === 'string' && /^https?:\/\//.test(origin)) {
    return origin.replace(/\/$/, '') + path;
  }
  return path;
}

function notificationIcon() {
  return assetUrl(PWA_NOTIFICATION_ICON);
}

function isSafeClubIconPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return false;
  try {
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin && url.pathname === '/api/pwa/icon';
  } catch {
    return false;
  }
}

function clubNotificationIcon(notification) {
  if (isSafeClubIconPath(notification.icon)) return assetUrl(notification.icon);
  const clubId = typeof notification.clubId === 'string' ? notification.clubId.trim() : '';
  if (/^[A-Za-z0-9_-]{1,64}$/.test(clubId)) {
    return assetUrl(`/api/pwa/icon?clubId=${encodeURIComponent(clubId)}&size=192&variant=plain`);
  }
  return notificationIcon();
}

function resolveNotificationUrl(rawUrl) {
  const fallback = new URL(APP_NOTIFICATION_URL, self.location.origin).href;
  if (!rawUrl) return fallback;
  try {
    return new URL(rawUrl, self.location.origin).href;
  } catch {
    return fallback;
  }
}

function notificationOptions(notification) {
  // Gabarit générique uniquement (issue #27) : plus de type/eventType/eventId d'origine
  // métier dans le tag — seulement l'identifiant opaque ou la catégorie de gabarit.
  const fallbackTag = notification.templateId || 'notification';
  return {
    body: notification.message || 'Vous avez une nouvelle notification.',
    icon: clubNotificationIcon(notification),
    badge: notificationIcon(),
    silent: false,
    vibrate: [200, 100, 200],
    tag: notification.notificationId ? `notification:${notification.notificationId}` : fallbackTag,
    renotify: true,
    data: {
      url: resolveNotificationUrl(notification.url || notification.href),
      notificationId: notification.notificationId || notification.id,
    },
  };
}

async function revealIncomingNotification(notification) {
  await clearStaleNotifications();
  const title = notification.title || 'Clubika';
  const options = notificationOptions(notification);
  const windowClients = typeof self.clients?.matchAll === 'function'
    ? await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    : [];

  for (const client of windowClients) {
    if (typeof client.postMessage === 'function') {
      client.postMessage({
        type: 'incoming-notification',
        title,
        body: options.body,
        url: options.data.url,
        icon: options.icon,
        notificationId: options.data.notificationId,
      });
    }
  }

  // Toujours afficher la notification système : une PWA installée (iOS / Android)
  // peut rester « visible » en arrière-plan, et iOS révoque l’abonnement si le
  // handler push n’appelle pas showNotification.
  await self.registration.showNotification(title, options);
}

async function showPushNotification(pushData) {
  if (pushData) {
    try {
      const notification = pushData.json();
      if (notification && typeof notification === 'object' && notification.notificationId) {
        await revealIncomingNotification(notification);
        return;
      }
    } catch (error) {
      console.error('Unable to decode push notification:', error);
    }
  }

  // Compatibilité avec les abonnements historiques sans clés de chiffrement : ces anciens
  // réveils sans payload continuent de fonctionner jusqu'au renouvellement de l'abonnement.
  await showLatestNotification();
}

/**
 * Compatibilité avec les abonnements historiques sans clés de chiffrement (issue #219) :
 * un simple réveil sans payload, sans aucune information sur la notification. Le contenu
 * affiché doit rester générique par défaut (issue #27) — jamais le titre/message réel de
 * `/api/notifications`, qui resterait affiché sur l'écran verrouillé sans authentification
 * ni aperçu détaillé opt-in. Le clic ouvre l'identifiant opaque de la notification la plus
 * récente, résolu après authentification par `/api/notifications/[id]/open`.
 */
async function showLatestNotification() {
  try {
    const response = await fetch('/api/notifications', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!response.ok) return;

    const data = await response.json();
    const notification = Array.isArray(data.notifications) ? data.notifications[0] : null;
    if (!notification || !notification.id) return;

    await revealIncomingNotification({
      notificationId: String(notification.id),
      title: 'Clubika',
      message: 'Vous avez une nouvelle notification. Ouvrez l’application pour la consulter.',
      url: `/api/notifications/${encodeURIComponent(notification.id)}/open`,
      clubId: notification.clubId,
    });
  } catch (error) {
    console.error('Unable to display push notification:', error);
  }
}

function isSameOriginClient(client) {
  try {
    return new URL(client.url, self.location.origin).origin === self.location.origin;
  } catch {
    return true;
  }
}

async function storePendingNotificationUrl(targetUrl) {
  if (typeof caches === 'undefined' || typeof caches.open !== 'function') return;
  try {
    const cache = await caches.open(PENDING_NOTIFICATION_CACHE);
    await cache.put(
      PENDING_NOTIFICATION_REQUEST,
      new Response(JSON.stringify({ url: targetUrl, at: Date.now() }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  } catch (error) {
    console.error('Unable to remember notification URL:', error);
  }
}

async function openNotificationTarget(targetUrl) {
  await storePendingNotificationUrl(targetUrl);

  const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const appClient = windowClients.find((client) => isSameOriginClient(client));

  if (appClient) {
    // iOS / certains WebAPK n'exposent pas WindowClient.navigate(). On demande à
    // l'application (Next.js) d'ouvrir la destination, puis on ramène la fenêtre au premier plan.
    if (typeof appClient.postMessage === 'function') {
      appClient.postMessage({ type: 'notification-navigate', url: targetUrl });
    }
    if (typeof appClient.focus === 'function') {
      await appClient.focus();
    }
    return appClient;
  }

  if (typeof self.clients.openWindow === 'function') {
    return self.clients.openWindow(targetUrl);
  }

  return undefined;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = resolveNotificationUrl(event.notification.data?.url);

  event.waitUntil(openNotificationTarget(targetUrl));
});
