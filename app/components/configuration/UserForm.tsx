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

interface UserFormProps {
  user?: ManagedUser;
}

interface UserFormState {
  email: string;
  password: string;
  nom: string;
  telephone: string;
  accessRole: ClubAccessRole;
  planningFunctions: PlanningFunction[];
  active: boolean;
}

function initialState(user?: ManagedUser): UserFormState {
  return {
    email: user?.email || '',
    password: '',
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

  if (user?.closedAt) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Compte fermé</CardTitle>
          <CardDescription>
            Ce compte a été anonymisé. L’identité nominative n’est plus disponible et le
            profil ne peut plus être modifié.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => router.push('/club/utilisateurs')}>Retour à la liste</Button>
        </CardContent>
      </Card>
    );
  }

  const handleCancel = () => router.push('/club/utilisateurs');

  const handleSubmit = async () => {
    if (!form.email.trim() || !form.nom.trim()) {
      toast.error('Email et nom sont requis');
      return;
    }
    if (!user && form.password.length < 8) {
      toast.error('Le mot de passe doit contenir au moins 8 caractères');
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
          ...(form.password ? { password: form.password } : {}),
        });
        toast.success('Utilisateur modifié');
      } else {
        await apiPost('/api/users', {
          email: form.email,
          password: form.password,
          nom: form.nom,
          accessRole: form.accessRole,
          planningFunctions: form.planningFunctions,
          telephone: form.telephone,
        });
        toast.success('Utilisateur créé');
      }
      router.push('/club/utilisateurs');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur inconnue');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{user ? "Modifier l'utilisateur" : 'Ajouter un utilisateur'}</CardTitle>
        <CardDescription>
          {user ? "Modifiez les informations de l'utilisateur" : 'Créez un compte directement (sans passer par une invitation)'}
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
        <div className="space-y-2">
          <Label htmlFor="user-password">
            Mot de passe {user && '(laisser vide pour ne pas changer)'}
          </Label>
          <Input
            id="user-password"
            type="password"
            value={form.password}
            onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
          />
        </div>
        <AccessRoleFields
          idPrefix="user"
          accessRole={form.accessRole}
          planningFunctions={form.planningFunctions}
          onAccessRoleChange={(accessRole) => setForm((prev) => ({
            ...prev,
            accessRole,
            // Un administrateur ne porte pas de fonction terrain : le passage en admin
            // les retire, le retour en dirigeant repart d'une sélection vide.
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

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <Button variant="outline" onClick={handleCancel} className="w-full sm:w-auto">
            Annuler
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving} className="w-full sm:w-auto">
            {isSaving ? 'Enregistrement...' : 'Enregistrer'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
