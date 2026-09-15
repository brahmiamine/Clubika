'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet, apiPut } from '@/lib/utils/api';
import { setChatSoundsEnabled } from '@/lib/chat/chatSound';
import { toast } from 'sonner';

interface Preferences {
  inApp: boolean;
  push: boolean;
  email: boolean;
  whatsapp: boolean;
  urgencyThreshold: 'normal' | 'important' | 'critical';
  eventTypes: string[];
  chatSounds: boolean;
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
    setSaving(true);
    try {
      const result = await apiPut<{ preferences: Preferences }>('/api/me/notification-preferences', preferences);
      setPreferences(result.preferences);
      setChatSoundsEnabled(result.preferences.chatSounds);
      toast.success('Préférences de notification enregistrées');
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Enregistrement impossible'); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-6">
        <div><h2 className="text-2xl font-bold">Notifications</h2><p className="text-sm text-muted-foreground">Choisissez les canaux secondaires. WhatsApp est désactivé par défaut et n’est envoyé qu’après un consentement explicite.</p></div>
        <Card><CardHeader><CardTitle className="text-base">Canaux</CardTitle></CardHeader><CardContent className="space-y-3">
          {([
            ['inApp', 'Dans l’application'], ['push', 'Push PWA / smartphone'], ['email', 'Email'],
          ] as const).map(([key, label]) => <label key={key} className="flex items-center justify-between rounded-md border p-3"><span>{label}</span><input type="checkbox" checked={preferences[key]} disabled={key === 'push' && !preferences.inApp} onChange={(event) => setPreferences({ ...preferences, [key]: event.target.checked })} /></label>)}
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
              ? 'Le canal serveur est configuré. Meta (WhatsApp Business) ou le webhook déclaré par l’administrateur est destinataire du numéro et du texte de la notification.'
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
