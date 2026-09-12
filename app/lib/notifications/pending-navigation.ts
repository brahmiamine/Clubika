export const PENDING_NOTIFICATION_NAV_CACHE = 'clubika-notification-nav-v1';
export const PENDING_NOTIFICATION_NAV_PATH = '/__pending-notification-url';
export const PENDING_NOTIFICATION_NAV_TTL_MS = 2 * 60 * 1000;

export function parsePendingNotificationRecord(raw: string, now = Date.now()): string | null {
  try {
    const data = JSON.parse(raw) as { url?: unknown; at?: unknown };
    if (typeof data.url !== 'string' || !data.url.trim()) return null;
    if (typeof data.at !== 'number' || now - data.at > PENDING_NOTIFICATION_NAV_TTL_MS) return null;
    return data.url.trim();
  } catch {
    return null;
  }
}

export async function consumePendingNotificationUrl(): Promise<string | null> {
  if (typeof caches === 'undefined' || typeof caches.open !== 'function') return null;
  try {
    const cache = await caches.open(PENDING_NOTIFICATION_NAV_CACHE);
    const match = await cache.match(PENDING_NOTIFICATION_NAV_PATH);
    if (!match) return null;
    const raw = await match.text();
    await cache.delete(PENDING_NOTIFICATION_NAV_PATH);
    return parsePendingNotificationRecord(raw);
  } catch {
    return null;
  }
}
