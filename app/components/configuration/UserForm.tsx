'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { toast } from 'sonner';
import { apiPost, apiPut } from '@/lib/utils/api';
import type { ClubAccessRole, PlanningFunction } from '@/lib/auth/roles';
import { AccessRoleFields } from './AccessRoleFields';
import type { ManagedUser } from '@/app/hooks/useUsers';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth/password-policy-constants';

interface UserFormProps {
  user?: ManagedUser;
}

interface UserFormState {
  email: string;
  nom: string;
  telephone: string;
  accessRole: ClubAccessRole;
  planningFunctions: PlanningFunction[];
  active: boolean;
}

function initialState(user?: ManagedUser): UserFormState {
  return {
    email: user?.email || '',
    nom: user?.nom || '',
    telephone: user?.telephone || '',
    accessRole: user?.accessRole ?? 'dirigeant',
    planningFunctions: user?.planningFunctions ?? [],
    active: user?.active ?? true,
  };
}

export function UserForm({ user }: UserFormProps) {
  const router = useRouter();
  const [form, setForm] = useState<UserFormState>(() => initialState(user));
  const [isSaving, setIsSaving] = useState(false);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  const handleCancel = () => router.push('/club/utilisateurs');

  const handleSubmit = async () => {
    if (!form.email.trim() || !form.nom.trim()) {
      toast.error('Email et nom sont requis');
      return;
    }
    setIsSaving(true);
    try {
      if (user) {
        await apiPut(`/api/users/${user.id}`, {
          nom: form.nom,
          accessRole: form.accessRole,
          planningFunctions: form.planningFunctions,
          active: form.active,
          telephone: form.telephone,
        });
        toast.success('Utilisateur modifié');
        router.push('/club/utilisateurs');
      } else {
        const data = await apiPost<{ url: string }>('/api/invitations', {
          email: form.email.trim(),
          accessRole: form.accessRole,
          planningFunctions: form.planningFunctions,
          personNom: form.nom.trim(),
        });
        const url = data.url.startsWith('http') ? data.url : `${window.location.origin}${data.url}`;
        setInviteUrl(url);
        toast.success('Invitation créée — copiez le lien plutôt que de choisir un mot de passe');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur inconnue');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{user ? "Modifier l'utilisateur" : 'Inviter un utilisateur'}</CardTitle>
        <CardDescription>
          {user
            ? "Modifiez le rôle et les informations. Le mot de passe ne peut pas être choisi à la place de la personne."
            : `La prise de contrôle du compte se fait par invitation (lien unique, ${PASSWORD_MIN_LENGTH} caractères minimum à l'inscription).`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="user-nom">Nom</Label>
          <Input
            id="user-nom"
            value={form.nom}
            onChange={(e) => setForm((prev) => ({ ...prev, nom: e.target.value }))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="user-email">Email</Label>
          <Input
            id="user-email"
            type="email"
            value={form.email}
            disabled={!!user}
            onChange={(e) => setForm((prev) => ({ ...prev, email: e.target.value }))}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="user-telephone">Téléphone</Label>
          <Input
            id="user-telephone"
            type="tel"
            value={form.telephone}
            onChange={(e) => setForm((prev) => ({ ...prev, telephone: e.target.value }))}
          />
        </div>
        <AccessRoleFields
          idPrefix="user"
          accessRole={form.accessRole}
          planningFunctions={form.planningFunctions}
          onAccessRoleChange={(accessRole) => setForm((prev) => ({
            ...prev,
            accessRole,
            planningFunctions: accessRole === 'admin' ? [] : prev.planningFunctions,
          }))}
          onPlanningFunctionsChange={(planningFunctions) => setForm((prev) => ({ ...prev, planningFunctions }))}
        />
        {user && (
          <div className="flex items-center gap-2">
            <input
              id="user-active"
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm((prev) => ({ ...prev, active: e.target.checked }))}
            />
            <Label htmlFor="user-active">Compte actif</Label>
          </div>
        )}
        {inviteUrl && (
          <div className="space-y-2">
            <Label>Lien d&apos;invitation (à copier, jamais un mot de passe choisi pour autrui)</Label>
            <Input id="user-invite-url" value={inviteUrl} readOnly className="font-mono text-xs" />
          </div>
        )}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <Button variant="outline" onClick={handleCancel} className="w-full sm:w-auto">
            {inviteUrl ? 'Fermer' : 'Annuler'}
          </Button>
          {!inviteUrl && (
            <Button onClick={handleSubmit} disabled={isSaving} className="w-full sm:w-auto">
              {isSaving ? 'Enregistrement...' : user ? 'Enregistrer' : 'Envoyer une invitation'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
