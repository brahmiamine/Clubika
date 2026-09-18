'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Checkbox } from '@/app/components/ui/checkbox';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { toast } from 'sonner';
import { apiPost } from '@/lib/utils/api';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { refreshAppSettingsTheme } from '@/app/hooks/useAppSettings';

export interface InvitationPublicView {
  valid: boolean;
  emailMasked: string | null;
  clubName: string;
  notice?: { version: string; text: string; disclaimer: string } | null;
}

const ALLOWED_REDIRECTS = new Set(['/club', '/mon-planning']);

function safeClientRedirect(path: string | undefined): string {
  if (path && ALLOWED_REDIRECTS.has(path)) return path;
  return '/mon-planning';
}

export function InscriptionForm({ invitation }: { invitation: InvitationPublicView }) {
  const router = useRouter();
  const { reload } = useCurrentUser();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nom, setNom] = useState('');
  const [confirmIdentity, setConfirmIdentity] = useState(false);
  const [acknowledgeNotice, setAcknowledgeNotice] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const clubName = invitation.clubName.trim() || 'Clubika';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const result = await apiPost<{ redirectTo?: string }>('/api/invitations/accept', {
        email,
        password,
        nom,
        confirmIdentity: true,
        acknowledgeNotice: true,
      });
      toast.success('Inscription réussie');
      await reload();
      await refreshAppSettingsTheme();
      router.push(safeClientRedirect(result.redirectTo));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Une erreur est survenue');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AuthShell brand={{ name: clubName }}>
      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold text-center">
          Créer votre compte
        </CardTitle>
        <CardDescription className="text-center">
          Invitation pour {clubName}
          {invitation.emailMasked ? ` — adresse indiquée : ${invitation.emailMasked}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/*
          Issue #18 : la V1 de Clubika réserve les comptes au staff majeur (admin,
          dirigeant, arbitre, encadrant, accompagnateur). Aucun parcours adapté aux
          mineurs n'a encore été conçu — voir la revue juridique et de conception
          dédiée demandée par l'issue avant toute ouverture aux mineurs. Ce message
          est indépendant de la notice club configurable ci-dessous (issue #26) ;
          en l'absence des CGU publiques (issue #12, pas encore fusionnées), ce
          rappel reste le seul texte public portant cette restriction — à faire
          coordonner avec les CGU dès qu'elles seront disponibles.
        */}
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">Comptes réservés aux personnes majeures</p>
          <p className="mt-1">
            Clubika V1 réserve les comptes au staff majeur. N&apos;acceptez cette invitation
            que si vous avez 18 ans ou plus : aucun parcours adapté aux mineurs n&apos;est
            proposé pour le moment.
          </p>
        </div>
        {invitation.notice ? (
          <div className="mb-4 space-y-2 rounded-md border p-3 text-sm">
            <p className="font-medium">Information (version {invitation.notice.version})</p>
            <p className="whitespace-pre-wrap text-muted-foreground">{invitation.notice.text}</p>
            <p className="text-xs text-muted-foreground">{invitation.notice.disclaimer}</p>
          </div>
        ) : null}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="nom">Nom</Label>
            <Input
              id="nom"
              type="text"
              placeholder="Votre nom"
              value={nom}
              onChange={(e) => setNom(e.target.value)}
              required
              autoFocus
              autoComplete="name"
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder={invitation.emailMasked ?? 'vous@exemple.com'}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              type="password"
              placeholder="8 caractères minimum"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              disabled={isSubmitting}
            />
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="confirmIdentity"
              checked={confirmIdentity}
              onCheckedChange={(value) => setConfirmIdentity(value === true)}
              disabled={isSubmitting}
            />
            <Label htmlFor="confirmIdentity" className="text-sm font-normal leading-5">
              Je confirme que cette adresse et cette identité m&apos;appartiennent.
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="acknowledgeNotice"
              checked={acknowledgeNotice}
              onCheckedChange={(value) => setAcknowledgeNotice(value === true)}
              disabled={isSubmitting}
            />
            <Label htmlFor="acknowledgeNotice" className="text-sm font-normal leading-5">
              Je confirme avoir pris connaissance des informations communiquées par le club concernant ce compte.
            </Label>
          </div>
          <Button
            type="submit"
            className="w-full"
            disabled={isSubmitting || !email || !password || !nom || !confirmIdentity || !acknowledgeNotice}
          >
            {isSubmitting ? 'Création...' : 'Créer mon compte'}
          </Button>
        </form>
      </CardContent>
    </AuthShell>
  );
}
