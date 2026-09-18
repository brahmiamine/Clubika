/** Navigateurs embarqués (IDE, Electron…) : PushManager existe mais sans backend FCM/APNs. */
export function isEmbeddedBrowser(userAgent: string): boolean {
  return /Electron\//i.test(userAgent) || /\bCursor\//i.test(userAgent);
}

/** Contexte navigateur où l’enregistrement Web Push a une chance de fonctionner. */
export function canUseWebPush(userAgent: string, isSecureContext: boolean): boolean {
  if (!isSecureContext) return false;
  if (isEmbeddedBrowser(userAgent)) return false;
  return true;
}

export function isPushServiceUnavailableError(error: unknown): boolean {
  if (!(error instanceof DOMException || error instanceof Error)) return false;
  return error.message.toLowerCase().includes('push service not available');
}

export function encodeBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = '';
  for (let index = 0; index < view.byteLength; index += 1) {
    binary += String.fromCharCode(view[index]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function subscriptionUsesVapidKey(
  applicationServerKey: ArrayBuffer | ArrayBufferView | null | undefined,
  publicKey: string,
): boolean {
  if (!applicationServerKey) return false;
  return encodeBase64Url(applicationServerKey) === publicKey.replace(/=+$/g, '');
}

export const PUSH_UNAVAILABLE_MESSAGE =
  'Les notifications push ne sont pas disponibles dans ce navigateur. '
  + 'Ouvrez l’application installée sur votre téléphone (Chrome ou Safari) pour les activer.';

/**
 * Désabonnement Web Push (issue #27) : révoque la souscription navigateur puis
 * supprime/révoque l'endpoint côté serveur (`/api/push/unsubscribe`) — appelé quand
 * l'utilisateur retire explicitement son opt-in push depuis les préférences. Best-effort :
 * une erreur réseau ne doit jamais bloquer l'enregistrement des préférences.
 */
export async function disableWebPushSubscription(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    // Best-effort : le retrait de la préférence serveur reste la source de vérité même
    // si la révocation navigateur/serveur échoue ici (ex. service worker non installé).
  }
}
