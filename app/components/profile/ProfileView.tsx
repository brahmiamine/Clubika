'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, KeyRound, UserRound } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { SectionCard } from '@/app/components/layout/page-primitives';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { apiPost, apiPut } from '@/lib/utils/api';
import type { NotifyChannel } from '@/lib/auth/session';
import { toast } from 'sonner';
import { ActiveSessionsCard } from './ActiveSessionsCard';

const NOTIFY_CHANNEL_LABELS: Record<NotifyChannel, string> = {
  push: 'Notifications dans l\'application',
  email: 'Email uniquement',
  both: 'Notifications dans l\'application et email',
};

/**
 * Vue unique du profil, partagée entre /club et /mon-planning (issue #93).
 */
export function ProfileView() {
  const { user, reload } = useCurrentUser();
  const router = useRouter();
  const [nom, setNom] = useState('');
  const [notifyChannel, setNotifyChannel] = useState<NotifyChannel>('push');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setNom(user.nom);
      setNotifyChannel(user.notifyChannel);
    }
  }, [user]);

  const save = async () => {
    setSaving(true);
    try {
      const result = await apiPut<{ passwordChanged: boolean }>('/api/me/profile', {
        nom,
        notifyChannel,
        currentPassword: currentPassword || undefined,
        newPassword: newPassword || undefined,
      });
      if (result.passwordChanged) {
        await apiPost('/api/auth/logout');
        toast.success('Mot de passe modifié. Reconnectez-vous.');
        await reload();
        router.push('/login');
        return;
      }
      await reload();
      toast.success('Profil mis à jour');
      setCurrentPassword('');
      setNewPassword('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Mise à jour impossible');
    } finally {
      setSaving(false);
    }
  };

  return (
        <SectionCard
          icon={<UserRound />}
          title="Mon profil"
          description="Informations du compte et sécurité."
          contentClassName="space-y-5"
        >
            <div className="space-y-2"><Label>Email</Label><Input value={user?.email ?? ''} readOnly /></div>
            <div className="space-y-2"><Label>Nom affiché</Label><Input value={nom} onChange={(e) => setNom(e.target.value)} /></div>
            <div className="space-y-3 rounded-xl border p-4">
              <h3 className="flex items-center gap-2 font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-soft text-primary"><Bell className="h-4 w-4" /></span> Notifications</h3>
              <div className="space-y-2">
                <Label htmlFor="notify-channel">Comment souhaitez-vous être prévenu ?</Label>
                <select
                  id="notify-channel"
                  className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
                  value={notifyChannel}
                  onChange={(e) => setNotifyChannel(e.target.value as NotifyChannel)}
                >
                  {(Object.keys(NOTIFY_CHANNEL_LABELS) as NotifyChannel[]).map((channel) => (
                    <option key={channel} value={channel}>{NOTIFY_CHANNEL_LABELS[channel]}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Ce réglage n’active ni ne bloque aucun canal : gérez précisément ce que vous recevez
                  (in-app, push, email, WhatsApp) depuis la page « Notifications ».
                </p>
              </div>
            </div>
            <div className="space-y-4 rounded-xl border p-4">
              <h3 className="flex items-center gap-2 font-semibold"><span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary-soft text-primary"><KeyRound className="h-4 w-4" /></span> Changer le mot de passe</h3>
              <div className="space-y-2"><Label>Mot de passe actuel</Label><Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></div>
              <div className="space-y-2"><Label>Nouveau mot de passe</Label><Input type="password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div>
              <p className="text-xs text-muted-foreground">Un changement de mot de passe déconnecte toutes les sessions actives.</p>
            </div>
            <ActiveSessionsCard
              listUrl="/api/me/sessions"
              revokeOthersUrl="/api/me/sessions/revoke-others"
              revokeUrl={(id) => `/api/me/sessions/${encodeURIComponent(id)}`}
            />
            <Button onClick={save} disabled={saving}>{saving ? 'Enregistrement...' : 'Enregistrer'}</Button>
        </SectionCard>
  );
}
