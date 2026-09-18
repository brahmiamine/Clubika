'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet, apiPut } from '@/lib/utils/api';
import { setChatSoundsEnabled } from '@/lib/chat/chatSound';
import { disableWebPushSubscription } from '@/lib/pwa/web-push-client';
import { toast } from 'sonner';

interface Preferences {
  inApp: boolean;
  push: boolean;
  email: boolean;
  whatsapp: boolean;
  urgencyThreshold: 'normal' | 'important' | 'critical';
  eventTypes: string[];
  chatSounds: boolean;
  pushDetailedPreview: boolean;
  emailDetailedPreview: boolean;
}

const EVENT_TYPES = [
  ['officiel', 'Match officiel'],
  ['amical', 'Match amical'],
  ['entrainement', 'Entraînement'],
  ['plateau', 'Plateau'],
] as const;

/**
 * Vue unique des préférences de notification, partagée entre /club et /mon-planning
 * (issue #93). `refreshKey` permet au wrapper de relancer le chargement.
 */
export function NotificationSettingsView({ refreshKey = 0 }: { refreshKey?: number }) {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [whatsappAvailable, setWhatsappAvailable] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ preferences: Preferences; whatsappAvailable?: boolean }>('/api/me/notification-preferences');
      setPreferences(data.preferences);
      setWhatsappAvailable(data.whatsappAvailable === true);
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Chargement impossible'); }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  if (!preferences) return <LoadingSpinner size={44} text="Chargement..." className="min-h-screen" />;

  const toggleEvent = (type: string) => setPreferences((current) => current ? {
    ...current,
    eventTypes: current.eventTypes.includes(type) ? current.eventTypes.filter((item) => item !== type) : [...current.eventTypes, type],
  } : current);

  const save = async () => {
    const wasPushEnabled = preferences.push;
    setSaving(true);
    try {
      const result = await apiPut<{ preferences: Preferences }>('/api/me/notification-preferences', preferences);
      setPreferences(result.preferences);
      setChatSoundsEnabled(result.preferences.chatSounds);
      // Retrait explicite et immédiat de l'abonnement Web Push (issue #27) : désactiver
      // le canal révoque aussi la souscription navigateur et l'endpoint côté serveur,
      // jamais seulement le drapeau de préférence.
      if (wasPushEnabled && !result.preferences.push) {
        void disableWebPushSubscription();
      }
      toast.success('Préférences de notification enregistrées');
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Enregistrement impossible'); }
    finally { setSaving(false); }
  };

  const setChannel = (key: 'push' | 'email', enabled: boolean) => setPreferences((current) => current ? {
    ...current,
    [key]: enabled,
    // Retirer le canal retire aussi son aperçu détaillé (issue #27) : jamais d'aperçu
    // détaillé actif sans son canal.
    ...(key === 'push' ? { pushDetailedPreview: enabled && current.pushDetailedPreview } : {}),
    ...(key === 'email' ? { emailDetailedPreview: enabled && current.emailDetailedPreview } : {}),
  } : current);

  return (
    <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-bold">Notifications</h2>
          <p className="text-sm text-muted-foreground">
            Par défaut, seule la notification dans l’application est active. Le push, l’email et
            WhatsApp sont désactivés par défaut : vous les activez explicitement ci-dessous, et
            pouvez les retirer à tout moment. Sur l’écran verrouillé, le push et l’email affichent
            un message générique (« Clubika ») — activez l’aperçu détaillé pour voir la catégorie
            (Planning, Compte…), jamais le contenu.
          </p>
        </div>
        <Card><CardHeader><CardTitle className="text-base">Canaux</CardTitle></CardHeader><CardContent className="space-y-3">
          <label className="flex items-center justify-between rounded-md border p-3">
            <span>Dans l’application</span>
            <input type="checkbox" checked={preferences.inApp} onChange={(event) => setPreferences({ ...preferences, inApp: event.target.checked })} />
          </label>
          <label className="flex items-center justify-between rounded-md border p-3">
            <span>Push PWA / smartphone</span>
            <input type="checkbox" checked={preferences.push} disabled={!preferences.inApp} onChange={(event) => setChannel('push', event.target.checked)} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 pl-6">
            <span className="text-sm text-muted-foreground">Aperçu détaillé du push (catégorie, jamais le contenu)</span>
            <input type="checkbox" checked={preferences.pushDetailedPreview} disabled={!preferences.push} onChange={(event) => setPreferences({ ...preferences, pushDetailedPreview: event.target.checked })} />
          </label>
          <label className="flex items-center justify-between rounded-md border p-3">
            <span>Email</span>
            <input type="checkbox" checked={preferences.email} onChange={(event) => setChannel('email', event.target.checked)} />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-md border p-3 pl-6">
            <span className="text-sm text-muted-foreground">Aperçu détaillé de l’email (catégorie, jamais le contenu)</span>
            <input type="checkbox" checked={preferences.emailDetailedPreview} disabled={!preferences.email} onChange={(event) => setPreferences({ ...preferences, emailDetailedPreview: event.target.checked })} />
          </label>
          {!preferences.inApp && <p className="text-xs text-muted-foreground">Le push PWA utilise la notification in-app comme source durable ; désactiver l’in-app désactive donc automatiquement le push.</p>}
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">WhatsApp (opt-in)</CardTitle></CardHeader><CardContent className="space-y-3">
          <label className="flex items-start justify-between gap-3 rounded-md border p-3">
            <span className="text-sm">
              J’accepte de recevoir des notifications WhatsApp sur le numéro de mon profil.
              Je peux retirer ce consentement à tout moment en décochant cette case.
            </span>
            <input
              type="checkbox"
              checked={preferences.whatsapp && whatsappAvailable}
              disabled={!whatsappAvailable}
              onChange={(event) => setPreferences({ ...preferences, whatsapp: event.target.checked })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {whatsappAvailable
              ? 'Le canal serveur est configuré. Meta (WhatsApp Business) ou le webhook déclaré par l’administrateur reçoit uniquement un message générique (jamais votre nom, ni le contenu de la notification).'
              : 'WhatsApp n’est pas activé sur ce serveur. Un administrateur doit poser explicitement WHATSAPP_PROVIDER=meta ou webhook, après revue contractuelle.'}
          </p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Niveau minimum pour les canaux secondaires</CardTitle></CardHeader><CardContent><select className="w-full rounded-md border bg-background px-3 py-2" value={preferences.urgencyThreshold} onChange={(event) => setPreferences({ ...preferences, urgencyThreshold: event.target.value as Preferences['urgencyThreshold'] })}><option value="normal">Toutes les notifications</option><option value="important">Importantes et critiques</option><option value="critical">Critiques uniquement</option></select></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Types d’événements</CardTitle></CardHeader><CardContent><p className="mb-3 text-xs text-muted-foreground">Aucune sélection = tous les événements. Ce filtre s’applique aux canaux email/push/WhatsApp ; l’in-app reste votre historique.</p><div className="flex flex-wrap gap-2">{EVENT_TYPES.map(([type, label]) => <Button key={type} type="button" variant={preferences.eventTypes.includes(type) ? 'default' : 'outline'} onClick={() => toggleEvent(type)}>{label}</Button>)}</div></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Chat</CardTitle></CardHeader><CardContent><label className="flex items-center justify-between rounded-md border p-3"><span>Sons du chat</span><input type="checkbox" checked={preferences.chatSounds} onChange={(event) => setPreferences({ ...preferences, chatSounds: event.target.checked })} /></label><p className="mt-2 text-xs text-muted-foreground">Un son discret à l’envoi et à la réception d’un message.</p></CardContent></Card>
        <Button onClick={save} disabled={saving}>{saving ? 'Enregistrement...' : 'Enregistrer'}</Button>
    </div>
  );
}
