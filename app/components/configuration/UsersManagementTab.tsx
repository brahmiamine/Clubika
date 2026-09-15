'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { DataCell, DataList, DataRow, SectionCard, StatusPill } from '@/app/components/layout/page-primitives';
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
import { Plus, Pencil, Trash2, UserCog, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useUsers } from '@/app/hooks/useUsers';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { apiDelete } from '@/lib/utils/api';
import {
  ACCESS_ROLE_LABELS,
  ALL_ACCESS_ROLES,
  ALL_PLANNING_FUNCTIONS,
  PLANNING_FUNCTION_LABELS,
  type ClubAccessRole,
  type PlanningFunction,
} from '@/lib/auth/roles';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';

type StatusFilter = 'all' | 'active' | 'inactive' | 'unclaimed' | 'closed';
type RoleFilter = 'all' | ClubAccessRole | PlanningFunction;

const USER_COLS = 'minmax(0,1.1fr) minmax(0,1.6fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1.2fr) auto 5rem';

export function UsersManagementTab() {
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();
  const { users, isLoading, reload } = useUsers();

  const [deleteUserId, setDeleteUserId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    return users.filter((user) => {
      if (roleFilter !== 'all'
        && user.accessRole !== roleFilter
        && !user.planningFunctions.includes(roleFilter as PlanningFunction)) return false;
      if (statusFilter === 'closed' && !user.closedAt) return false;
      if (statusFilter === 'active' && (!user.active || Boolean(user.closedAt))) return false;
      if (statusFilter === 'inactive' && (user.active || Boolean(user.closedAt))) return false;
      // Profils de dirigeants jamais activés (issue #204) : ce ne sont pas des
      // comptes actifs, ils attendent une invitation ciblée.
      if (statusFilter === 'unclaimed' && (user.hasAccess || Boolean(user.closedAt))) return false;
      if (term) {
        const haystack = `${user.nom} ${user.email} ${user.telephone ?? ''}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [users, search, roleFilter, statusFilter]);

  const handleDeleteUser = async () => {
    if (deleteUserId === null) return;
    try {
      await apiDelete(`/api/users/${deleteUserId}`);
      toast.success('Compte fermé et anonymisé', {
        description: 'L’identité nominative a été remplacée par « Utilisateur supprimé ».',
      });
      setDeleteUserId(null);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur inconnue');
    }
  };

  if (isLoading) {
    return <LoadingSpinner size={40} text="Chargement..." className="py-20" />;
  }

  return (
    <div className="space-y-6">
      <SectionCard
        icon={<UserCog />}
        title="Utilisateurs"
        description="Gérez les comptes, leur rôle d'accès et leurs fonctions opérationnelles"
        actions={
          <Button onClick={() => router.push('/club/utilisateurs/nouveau')} size="sm">
            <Plus className="h-4 w-4 mr-2" />
            Ajouter
          </Button>
        }
        contentClassName="space-y-4"
      >
          <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Rechercher par nom, email ou téléphone"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as RoleFilter)}
            >
              <option value="all">Tous les rôles et fonctions</option>
              {ALL_ACCESS_ROLES.map((role) => (
                <option key={role} value={role}>{ACCESS_ROLE_LABELS[role]}</option>
              ))}
              {ALL_PLANNING_FUNCTIONS.map((planningFunction) => (
                <option key={planningFunction} value={planningFunction}>
                  {PLANNING_FUNCTION_LABELS[planningFunction]}
                </option>
              ))}
            </select>
            <select
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              <option value="all">Tous les statuts</option>
              <option value="active">Actifs</option>
              <option value="inactive">Désactivés</option>
              <option value="unclaimed">Sans accès</option>
              <option value="closed">Fermés</option>
            </select>
          </div>

          <DataList
            columns={USER_COLS}
            isEmpty={filteredUsers.length === 0}
            empty={users.length === 0 ? 'Aucun utilisateur' : 'Aucun utilisateur ne correspond aux filtres'}
            header={
              <>
                <span>Nom</span>
                <span>Email</span>
                <span>Téléphone</span>
                <span>Rôle</span>
                <span>Fonctions</span>
                <span>Statut</span>
                <span className="sr-only">Actions</span>
              </>
            }
          >
            {filteredUsers.map((user) => {
              const functionsLabel = user.planningFunctions
                .map((fn) => PLANNING_FUNCTION_LABELS[fn])
                .join(', ');
              const closed = Boolean(user.closedAt);
              const status = closed ? (
                <StatusPill tone="danger" title="Identité anonymisée ; le stub technique reste pour les clés étrangères">
                  Fermé
                </StatusPill>
              ) : !user.hasAccess ? (
                <StatusPill tone="warning" title="Profil créé sans identifiants : activez-le depuis la page Invitations">
                  Sans accès
                </StatusPill>
              ) : (
                <StatusPill tone={user.active ? 'success' : 'danger'}>
                  {user.active ? 'Actif' : 'Désactivé'}
                </StatusPill>
              );
              const actions = (
                <div className="flex shrink-0 items-center">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Modifier l'utilisateur"
                    disabled={closed}
                    onClick={() => router.push(`/club/utilisateurs/${user.id}`)}
                  >
                    <Pencil className="h-4 w-4 text-primary" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    aria-label="Fermer le compte"
                    disabled={closed || user.id === currentUser?.id}
                    onClick={() => setDeleteUserId(user.id)}
                  >
                    <Trash2 className="h-4 w-4 text-primary" />
                  </Button>
                </div>
              );

              return (
                <DataRow key={user.id} columns={USER_COLS} className="gap-0 py-2.5 sm:gap-3 sm:py-3.5">
                  <div className="flex items-center gap-2 sm:hidden">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 truncate font-medium text-foreground">{user.nom}</p>
                        {status}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {user.email}
                        {user.telephone ? ` · ${user.telephone}` : ''}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {ACCESS_ROLE_LABELS[user.accessRole]}
                        {functionsLabel ? ` · ${functionsLabel}` : ''}
                      </p>
                    </div>
                    {actions}
                  </div>
                  <div className="hidden sm:contents">
                    <DataCell>
                      <span className="font-medium text-foreground">{user.nom}</span>
                    </DataCell>
                    <DataCell className="text-muted-foreground break-words">{user.email || '—'}</DataCell>
                    <DataCell className="text-muted-foreground">{user.telephone || '—'}</DataCell>
                    <DataCell className="text-muted-foreground">{ACCESS_ROLE_LABELS[user.accessRole]}</DataCell>
                    <DataCell className="text-muted-foreground">{functionsLabel || '—'}</DataCell>
                    <DataCell>{status}</DataCell>
                    <DataCell align="end">
                      <div className="flex justify-end">{actions}</div>
                    </DataCell>
                  </div>
                </DataRow>
              );
            })}
          </DataList>

          <p className="text-xs text-muted-foreground">
            {filteredUsers.length} / {users.length} utilisateur{users.length > 1 ? 's' : ''}
          </p>
      </SectionCard>

      <AlertDialog open={deleteUserId !== null} onOpenChange={(open) => !open && setDeleteUserId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Fermer et anonymiser le compte</AlertDialogTitle>
            <AlertDialogDescription>
              L’identité (nom, e-mail, téléphone, mot de passe, sessions, iCal, invitations, push)
              sera effacée. Le nom affiché dans le planning et le chat deviendra « Utilisateur
              supprimé ». Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteUser}>Fermer le compte</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
