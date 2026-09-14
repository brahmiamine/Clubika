'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { BellRing, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/app/components/ui/button';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppSettings } from '@/hooks/useAppSettings';
import {
  canOfferPwaInstall,
  isMobileUserAgent,
  pwaInstallFallbackMessage,
} from '@/lib/pwa/install-prompt';
import { buildPwaIconUrl } from '@/lib/pwa/icons';
import { applyAppProductDocumentHead, applyClubPwaDocumentHead } from '@/lib/pwa/document-head';
import { usesAppProductDocumentHead, usesTokenClubDocumentHead } from '@/lib/pwa/document-routes';
import { buildPwaAppName, buildPwaShortName } from '@/lib/pwa/names';
import {
  canUseWebPush,
  isPushServiceUnavailableError,
  PUSH_UNAVAILABLE_MESSAGE,
  subscriptionUsesVapidKey,
} from '@/lib/pwa/web-push-client';
import { appPathFromNotificationUrl, notificationNavigateHref } from '@/lib/notifications/destinations';
import { consumePendingNotificationUrl } from '@/lib/notifications/pending-navigation';
import { isStandaloneDisplay } from '@/lib/pwa/display-mode';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface PushConfig {
  enabled: boolean;
  publicKey: string | null;
}

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return isMobileUserAgent(navigator.userAgent);
}

function base64UrlToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return buffer;
}

async function getPushConfig(): Promise<PushConfig> {
  const response = await fetch('/api/push/config', { cache: 'no-store' });
  if (!response.ok) return { enabled: false, publicKey: null };
  return response.json() as Promise<PushConfig>;
}

async function getServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

async function syncSubscription(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !canUseWebPush(navigator.userAgent, window.isSecureContext)) {
    return false;
  }

  const config = await getPushConfig();
  if (!config.enabled || !config.publicKey) return false;

  const registration = await getServiceWorkerRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !subscriptionUsesVapidKey(subscription.options.applicationServerKey, config.publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }

  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToArrayBuffer(config.publicKey),
    });
  }

  const response = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  });

  if (!response.ok) {
    throw new Error("Impossible d'enregistrer ce téléphone pour les notifications");
  }

  return true;
}

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const { user } = useCurrentUser();
  const { settings } = useAppSettings();
  const pathname = usePathname();
  const router = useRouter();
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [standalone, setStandalone] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>('default');
  const [installDismissed, setInstallDismissed] = useState(false);
  const [pushDismissed, setPushDismissed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStandalone(isStandaloneDisplay());
    setPushSupported('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window);
    if ('Notification' in window) setPushPermission(Notification.permission);

    if ('serviceWorker' in navigator) {
      const onInvitationPage = pathname === '/inscription' || pathname.startsWith('/inscription/');
      if (!onInvitationPage) {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
          console.error('Service worker registration failed:', error);
        });
      }
    }

    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setStandalone(true);
      setInstallPrompt(null);
      toast.success(`${buildPwaAppName(settings.clubName)} est installé sur votre téléphone`);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [pathname, settings.clubName]);

  useEffect(() => {
    if (usesTokenClubDocumentHead(pathname)) return;
    if (usesAppProductDocumentHead(pathname)) {
      applyAppProductDocumentHead();
      return;
    }
    if (!user) return;

    const version = `${settings.clubLogo.length}-${settings.primaryColor.replace('#', '')}`;
    const iconHref = buildPwaIconUrl({
      clubId: user.clubId,
      size: 192,
      variant: 'plain',
      version,
    });
    applyClubPwaDocumentHead({
      iconHref,
      manifestHref: `/manifest.webmanifest?clubId=${encodeURIComponent(user.clubId)}&v=${encodeURIComponent(version)}`,
      appName: buildPwaAppName(settings.clubName),
      shortName: buildPwaShortName(settings.clubName),
      themeColor: settings.primaryColor,
    });
  }, [settings.clubLogo, settings.clubName, settings.primaryColor, user, pathname]);

  useEffect(() => {
    if (!user || !pushSupported || pushPermission !== 'granted') return;
    if (typeof navigator === 'undefined' || !canUseWebPush(navigator.userAgent, window.isSecureContext)) return;
    syncSubscription().catch((error) => {
      if (isPushServiceUnavailableError(error)) return;
      console.error('Push subscription sync failed:', error);
    });
  }, [user, pushSupported, pushPermission]);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined;

    const applyHref = (href: string) => {
      const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (href !== current) router.push(href);
    };

    const applyPending = async () => {
      const raw = await consumePendingNotificationUrl();
      if (!raw) return;
      const href = appPathFromNotificationUrl(raw, window.location.origin);
      if (href) applyHref(href);
    };

    const onMessage = (event: MessageEvent) => {
      const href = notificationNavigateHref(event.data, window.location.origin);
      if (href) applyHref(href);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void applyPending();
    };

    void applyPending();
    navigator.serviceWorker.addEventListener('message', onMessage);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  const installAllowedOnRoute = canOfferPwaInstall(pathname, user?.accessRole ?? null);

  const canOfferInstall = useMemo(
    () =>
      installAllowedOnRoute
      && !standalone
      && !installDismissed
      // Sur mobile, on affiche toujours le bandeau : `beforeinstallprompt` est souvent
      // absent (tunnel dev, critères Chrome, visite trop courte). Le bouton déclenche
      // le prompt natif quand disponible, sinon des instructions manuelles.
      && (Boolean(installPrompt) || isMobile()),
    [installAllowedOnRoute, standalone, installDismissed, installPrompt],
  );

  const canOfferPush = Boolean(
    user && standalone && pushSupported && pushPermission !== 'granted' && !pushDismissed,
  );

  const installApp = useCallback(async () => {
    if (!installPrompt) {
      toast.info(pwaInstallFallbackMessage(navigator.userAgent, buildPwaAppName(settings.clubName)));
      return;
    }

    setBusy(true);
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        setStandalone(true);
        setInstallPrompt(null);
      }
    } finally {
      setBusy(false);
    }
  }, [installPrompt, settings.clubName]);

  const enablePush = useCallback(async () => {
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      setPushPermission(permission);
      if (permission !== 'granted') {
        toast.error('Les notifications ont été refusées dans les réglages du téléphone.');
        return;
      }

      if (typeof navigator !== 'undefined' && !canUseWebPush(navigator.userAgent, window.isSecureContext)) {
        toast.error(PUSH_UNAVAILABLE_MESSAGE);
        return;
      }

      const enabled = await syncSubscription();
      if (enabled) {
        toast.success('Notifications smartphone activées');
      } else {
        toast.error("Les clés VAPID ne sont pas encore configurées sur le serveur.");
      }
    } catch (error) {
      if (isPushServiceUnavailableError(error)) {
        toast.error(PUSH_UNAVAILABLE_MESSAGE);
        return;
      }
      toast.error(error instanceof Error ? error.message : "Impossible d'activer les notifications");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <>
      {canOfferInstall && (
        <div className="sticky top-0 z-[70] flex shrink-0 items-center justify-between gap-2 border-b bg-primary px-3 py-2 text-primary-foreground lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={
                settings.clubLogo
                || (user
                  ? buildPwaIconUrl({ clubId: user.clubId, size: 192, variant: 'plain' })
                  : '/branding/clubika-icon.png')
              }
              alt=""
              className="h-8 w-8 shrink-0 rounded-lg bg-white object-contain p-1"
            />
            <span className="truncate text-sm font-medium">Installer {buildPwaAppName(settings.clubName)}</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="secondary" onClick={installApp} disabled={busy} className="min-h-9">
              Installer
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-10 w-10 text-primary-foreground hover:text-primary"
              onClick={() => setInstallDismissed(true)}
              aria-label="Masquer"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {canOfferPush && (
        <div className="sticky top-0 z-[70] flex shrink-0 items-center justify-between gap-2 border-b bg-primary px-3 py-2 text-primary-foreground lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <BellRing className="h-4 w-4 shrink-0" />
            <span className="truncate text-sm font-medium">Recevoir les désignations sur votre téléphone</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" variant="secondary" onClick={enablePush} disabled={busy} className="min-h-9">
              Activer
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-10 w-10 text-primary-foreground hover:text-primary"
              onClick={() => setPushDismissed(true)}
              aria-label="Masquer"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {children}
    </>
  );
}
