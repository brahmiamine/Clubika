'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, KeyRound, UserRound } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { SectionCard } from '@/app/components/layout/page-primitives';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/app/components/ui/alert-dialog';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { apiGet, apiPost, apiPut } from '@/lib/utils/api';
import type { NotifyChannel } from '@/lib/auth/session';
import { toast } from 'sonner';
import { ActiveSessionsCard } from './ActiveSessionsCard';

const NOTIFY_CHANNEL_LABELS: Record<NotifyChannel, string> = {
  push: 'Notifications dans l\'application',
  email: 'Email uniquement',
  both: 'Notifications dans l\'application et email',
};

interface ClosurePreview {
  displayName: string;
  retained: Array<{ category: string; kept: boolean; justification: string }>;
}

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
  const [closureOpen, setClosureOpen] = useState(false);
  const [closureBusy, setClosureBusy] = useState(false);
  const [closurePreview, setClosurePreview] = useState<ClosurePreview | null>(null);

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

  const openClosureDialog = async () => {
    setClosureBusy(true);
    try {
      const data = await apiGet<{ preview: ClosurePreview }>('/api/me/account-closure');
      setClosurePreview(data.preview);
      setClosureOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Aperçu de fermeture indisponible');
    } finally {
      setClosureBusy(false);
    }
  };

  const confirmClosure = async () => {
    setClosureBusy(true);
    try {
      const result = await apiPost<{
        requested?: boolean;
        closure?: { preview: ClosurePreview };
        preview?: ClosurePreview;
      }>('/api/me/account-closure', { confirm: true });
      const retained = (result.closure?.preview ?? result.preview)?.retained
        ?.filter((item) => item.kept)
        .map((item) => item.justification)
        .join(' ') ?? '';
      await apiPost('/api/auth/logout');
      toast.success('Compte fermé et anonymisé', retained ? { description: retained } : undefined);
      await reload();
      router.push('/login');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Fermeture impossible');
      setClosureBusy(false);
    }
  };

  return (
        <>
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
              <div className="space-y-2"><Label>Nouveau mot de passe</Label><Input type="password" minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></div>
              <p className="text-xs text-muted-foreground">Au moins 12 caractères, phrase de passe acceptée. Un changement déconnecte toutes les sessions.</p>
            </div>
            <ActiveSessionsCard
              listUrl="/api/me/sessions"
              revokeOthersUrl="/api/me/sessions/revoke-others"
              revokeUrl={(id) => `/api/me/sessions/${encodeURIComponent(id)}`}
            />
            <Button onClick={save} disabled={saving}>{saving ? 'Enregistrement...' : 'Enregistrer'}</Button>
            <div className="space-y-3 rounded-xl border border-destructive/30 p-4">
              <h3 className="font-semibold text-destructive">Fermer mon compte</h3>
              <p className="text-sm text-muted-foreground">
                Votre nom, e-mail, téléphone et mot de passe seront effacés. Les affectations et
                messages resteront visibles des autres membres sous le libellé « Utilisateur
                supprimé ». Cette action est irréversible.
              </p>
              <Button variant="destructive" onClick={openClosureDialog} disabled={closureBusy}>
                {closureBusy ? 'Chargement...' : 'Demander la fermeture'}
              </Button>
            </div>
        </SectionCard>
        <AlertDialog open={closureOpen} onOpenChange={setClosureOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Confirmer la fermeture du compte</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>
                    Le nom affiché deviendra « {closurePreview?.displayName ?? 'Utilisateur supprimé'} ».
                    Les accès (sessions, iCal, invitations, push) seront révoqués immédiatement.
                  </p>
                  {closurePreview?.retained.filter((item) => item.kept).map((item) => (
                    <p key={item.category}>{item.justification}</p>
                  ))}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={closureBusy}>Annuler</AlertDialogCancel>
              <AlertDialogAction onClick={confirmClosure} disabled={closureBusy}>
                Fermer définitivement
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </>
  );
}
