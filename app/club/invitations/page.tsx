'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import {
  DataCell,
  DataList,
  DataRow,
  PageContainer,
  PageHeader,
  SectionCard,
  StatusPill,
  type StatusTone,
} from '@/app/components/layout/page-primitives';
import { Check, Copy, Link2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useInvitations } from '@/app/hooks/useInvitations';
import { apiGet, apiPost, apiDelete } from '@/lib/utils/api';
import type { ManagedUser } from '@/app/hooks/useUsers';
import {
  ACCESS_ROLE_LABELS,
  PLANNING_FUNCTION_LABELS,
  type ClubAccessRole,
  type PlanningFunction,
} from '@/lib/auth/roles';
import { AccessRoleFields } from '@/app/components/configuration/AccessRoleFields';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';

type StatusFilter = 'all' | 'pending' | 'used' | 'expired';

function invitationStatus(invitation: { usedAt: string | null; expiresAt: string }): Exclude<StatusFilter, 'all'> {
  if (invitation.usedAt) return 'used';
  if (new Date(invitation.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'pending';
}

const STATUS_LABELS: Record<Exclude<StatusFilter, 'all'>, string> = {
  pending: 'En attente',
  used: 'Utilisée',
  expired: 'Expirée',
};

const STATUS_TONE: Record<Exclude<StatusFilter, 'all'>, StatusTone> = {
  pending: 'info',
  used: 'success',
  expired: 'danger',
};

const INVITATION_COLS = 'minmax(0,1fr) minmax(0,1.3fr) minmax(0,1.6fr) minmax(0,1.1fr) auto auto 2.75rem';

function CopyableUrlField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success('Lien copié');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Impossible de copier le lien');
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input value={url} readOnly className="font-mono text-xs" />
      <Button type="button" variant="outline" size="icon" onClick={handleCopy}>
        {copied ? <Check className="h-4 w-4 text-green-600 dark:text-green-400" /> : <Copy className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export default function InvitationsPage() {
  const { invitations, isLoading, reload } = useInvitations();

  const [inviteAccessRole, setInviteAccessRole] = useState<ClubAccessRole>('dirigeant');
  const [inviteFunctions, setInviteFunctions] = useState<PlanningFunction[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [invitePersonId, setInvitePersonId] = useState<number | ''>('');
  const [isCreating, setIsCreating] = useState(false);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  // Profils de dirigeants sans accès du club, activables via une invitation ciblée
  // (issue #204) : l'acceptation rattache les identifiants au profil existant.
  const [unclaimedProfiles, setUnclaimedProfiles] = useState<ManagedUser[]>([]);

  useEffect(() => {
    apiGet<{ users: ManagedUser[] }>('/api/users?sansAcces=1')
      .then((data) => setUnclaimedProfiles(data.users || []))
      .catch(() => setUnclaimedProfiles([]));
  }, [invitations]);

  const filteredInvitations = useMemo(() => {
    if (statusFilter === 'all') return invitations;
    return invitations.filter((invitation) => invitationStatus(invitation) === statusFilter);
  }, [invitations, statusFilter]);

  const handleCreate = async () => {
    // Une invitation administrateur non liée à un email pourrait être utilisée par
    // n'importe qui pour créer ou promouvoir plusieurs comptes admin (issue #271) ;
    // l'API refuse aussi cette combinaison, ce contrôle n'est qu'un raccourci pour l'UX.
    if (inviteAccessRole === 'admin' && !inviteEmail.trim()) {
      toast.error('Une invitation administrateur doit être liée à une adresse email');
      return;
    }
    setIsCreating(true);
    try {
      const data = await apiPost<{ url: string }>('/api/invitations', {
        accessRole: inviteAccessRole,
        planningFunctions: inviteFunctions,
        email: inviteEmail || undefined,
        personId: invitePersonId === '' ? undefined : invitePersonId,
      });
      const fullUrl = data.url.startsWith('http') ? data.url : `${window.location.origin}${data.url}`;
      setLastInviteUrl(fullUrl);
      setInviteEmail('');
      setInvitePersonId('');
      toast.success('Lien d\'invitation généré');
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur inconnue');
    } finally {
      setIsCreating(false);
    }
  };

  const handleRevoke = async (token: string) => {
    try {
      await apiDelete(`/api/invitations/${token}`);
      toast.success('Invitation révoquée');
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur inconnue');
    }
  };

  if (isLoading) {
    return <LoadingSpinner size={40} text="Chargement..." className="py-20" />;
  }

  return (
    <PageContainer>
      <PageHeader
        icon={<Link2 />}
        title="Invitations"
        description="Générez un lien d'invitation à copier-coller et à partager avec la personne à inviter."
      />

      <SectionCard
        title="Nouvelle invitation"
        description="Le lien est valable un temps limité et à usage unique."
      >
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <AccessRoleFields
              idPrefix="invite"
              accessRole={inviteAccessRole}
              planningFunctions={inviteFunctions}
              onAccessRoleChange={(accessRole) => {
                setInviteAccessRole(accessRole);
                if (accessRole === 'admin') setInviteFunctions([]);
              }}
              onPlanningFunctionsChange={setInviteFunctions}
            />
            <div className="space-y-2">
              <Label htmlFor="invite-email">
                {inviteAccessRole === 'admin' ? 'Email (requis pour un administrateur)' : 'Email (optionnel)'}
              </Label>
              <Input
                id="invite-email"
                type="email"
                placeholder="vous@exemple.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="invite-person">Activer un profil existant (optionnel)</Label>
              <select
                id="invite-person"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={invitePersonId}
                onChange={(e) => setInvitePersonId(e.target.value === '' ? '' : Number(e.target.value))}
              >
                <option value="">Nouveau compte</option>
                {unclaimedProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.nom}
                    {profile.planningFunctions.length > 0
                      ? ` — ${profile.planningFunctions.map((fn) => PLANNING_FUNCTION_LABELS[fn]).join(', ')}`
                      : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                L&apos;acceptation rattache les identifiants au profil choisi, sans créer de doublon.
              </p>
            </div>
          </div>
          <Button onClick={handleCreate} disabled={isCreating}>
            {isCreating ? 'Génération...' : 'Générer un lien d\'invitation'}
          </Button>

          {lastInviteUrl && (
            <div className="pt-2 space-y-1">
              <Label>Lien généré</Label>
              <CopyableUrlField url={lastInviteUrl} />
            </div>
          )}
        </div>
      </SectionCard>

      <SectionCard
        title="Invitations créées"
        flush
        actions={
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">Tous les statuts</option>
            <option value="pending">En attente</option>
            <option value="used">Utilisées</option>
            <option value="expired">Expirées</option>
          </select>
        }
      >
        <DataList
          className="rounded-none border-0"
          columns={INVITATION_COLS}
          isEmpty={filteredInvitations.length === 0}
          empty={invitations.length === 0 ? 'Aucune invitation créée' : 'Aucune invitation ne correspond au filtre'}
          header={
            <>
              <span>Rôle</span>
              <span>Fonctions</span>
              <span>Email</span>
              <span>Personne liée</span>
              <span>Statut</span>
              <span>Expire le</span>
              <span className="sr-only">Actions</span>
            </>
          }
        >
          {filteredInvitations.map((invitation) => {
            const status = invitationStatus(invitation);
            const functionsLabel = invitation.planningFunctions
              .map((fn) => PLANNING_FUNCTION_LABELS[fn])
              .join(', ');
            const expiresLabel = new Date(invitation.expiresAt).toLocaleDateString('fr-FR');
            const contactLabel = [invitation.email, invitation.personNom].filter(Boolean).join(' · ');
            const statusPill = (
              <StatusPill tone={STATUS_TONE[status]}>{STATUS_LABELS[status]}</StatusPill>
            );
            const actions = status === 'pending' ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                aria-label="Révoquer l'invitation"
                onClick={() => handleRevoke(invitation.id)}
              >
                <Trash2 className="h-4 w-4 text-primary" />
              </Button>
            ) : null;

            return (
              <DataRow key={invitation.id} columns={INVITATION_COLS} className="gap-0 py-2.5 sm:gap-3 sm:py-3.5">
                <div className="flex items-center gap-2 sm:hidden">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="min-w-0 truncate font-medium text-foreground">
                        {ACCESS_ROLE_LABELS[invitation.accessRole]}
                      </p>
                      {statusPill}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {contactLabel || '—'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {functionsLabel ? `${functionsLabel} · ` : ''}
                      Expire le {expiresLabel}
                    </p>
                  </div>
                  {actions}
                </div>
                <div className="hidden sm:contents">
                  <DataCell>
                    <span className="font-medium text-foreground">{ACCESS_ROLE_LABELS[invitation.accessRole]}</span>
                  </DataCell>
                  <DataCell className="text-muted-foreground">{functionsLabel || '—'}</DataCell>
                  <DataCell className="text-muted-foreground break-words">{invitation.email || '—'}</DataCell>
                  <DataCell className="text-muted-foreground">{invitation.personNom || '—'}</DataCell>
                  <DataCell>{statusPill}</DataCell>
                  <DataCell className="text-muted-foreground">{expiresLabel}</DataCell>
                  <DataCell align="end">
                    <div className="flex justify-end">{actions}</div>
                  </DataCell>
                </div>
              </DataRow>
            );
          })}
        </DataList>
      </SectionCard>
    </PageContainer>
  );
}
