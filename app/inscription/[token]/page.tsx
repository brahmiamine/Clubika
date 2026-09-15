'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { toast } from 'sonner';
import { apiGet, apiPost } from '@/lib/utils/api';
import {
  ACCESS_ROLE_LABELS,
  PLANNING_FUNCTION_LABELS,
  type ClubAccessRole,
  type PlanningFunction,
} from '@/lib/auth/roles';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { refreshAppSettingsTheme } from '@/app/hooks/useAppSettings';
import {
  applyDefaultThemeVariables,
  applyThemeVariables,
  DEFAULT_APP_SETTINGS,
  hasThemeUserOverride,
  type ThemeMode,
} from '@/lib/settings';
import { useTheme } from 'next-themes';

interface InvitationClubBrand {
  name: string;
  logo: string;
  primaryColor: string;
  accentColor: string;
  themeMode: ThemeMode;
}

interface InvitationValidation {
  valid: boolean;
  email: string | null;
  accessRole: ClubAccessRole;
  planningFunctions: PlanningFunction[];
  personNom: string | null;
  notice?: { version: string; text: string; disclaimer: string } | null;
  club?: InvitationClubBrand;
  error?: string;
}

export default function InscriptionPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const router = useRouter();
  const { reload } = useCurrentUser();
  const { setTheme } = useTheme();

  const [invitation, setInvitation] = useState<InvitationValidation | null>(null);
  const [isValidating, setIsValidating] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nom, setNom] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!token) {
      return;
    }
    apiGet<InvitationValidation>(`/api/invitations/${token}`)
      .then((data) => {
        setInvitation(data);
        if (data.email) {
          setEmail(data.email);
        }
        // Invitation ciblant un profil existant (issue #204) : le nom du profil est
        // pré-rempli, la personne peut encore l'ajuster.
        if (data.personNom) {
          setNom(data.personNom);
        }
      })
      .catch((err) => {
        setValidationError(err instanceof Error ? err.message : 'Lien d\'invitation invalide');
      })
      .finally(() => setIsValidating(false));
  }, [token]);

  useEffect(() => {
    const club = invitation?.club;
    if (!club) {
      applyDefaultThemeVariables();
      return;
    }

    applyThemeVariables({
      ...DEFAULT_APP_SETTINGS,
      primaryColor: club.primaryColor,
      accentColor: club.accentColor,
    });
    if (!hasThemeUserOverride()) {
      setTheme(club.themeMode);
    }
  }, [invitation, setTheme]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      const result = await apiPost<{ redirectTo?: string }>(`/api/invitations/${token}/accept`, { email, password, nom });
      toast.success('Inscription réussie');
      await reload();
      await refreshAppSettingsTheme();
      router.push(result.redirectTo || '/mon-planning');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Une erreur est survenue');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isValidating) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-secondary-soft p-4">
        <LoadingSpinner text="Vérification du lien d'invitation..." />
      </div>
    );
  }

  if (validationError || !invitation?.valid) {
    return (
      <AuthShell>
        <CardHeader>
          <CardTitle className="text-center">Lien invalide</CardTitle>
          <CardDescription className="text-center">
            {validationError || invitation?.error || 'Ce lien d\'invitation n\'est plus valide.'}
          </CardDescription>
        </CardHeader>
      </AuthShell>
    );
  }

  const clubBrand = invitation.club
    ? { name: invitation.club.name, logo: invitation.club.logo }
    : null;

  return (
    <AuthShell brand={clubBrand}>
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">
            Créer votre compte
          </CardTitle>
          <CardDescription className="text-center">
            Vous êtes invité(e) en tant que {ACCESS_ROLE_LABELS[invitation.accessRole]}{invitation.planningFunctions.length > 0
              && ` (${invitation.planningFunctions.map((fn) => PLANNING_FUNCTION_LABELS[fn]).join(', ')})`}
          </CardDescription>
        </CardHeader>
        <CardContent>
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
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="vous@exemple.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isSubmitting || !!invitation.email}
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
                disabled={isSubmitting}
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || !email || !password || !nom}
            >
              {isSubmitting ? 'Création...' : 'Créer mon compte'}
            </Button>
          </form>
        </CardContent>
    </AuthShell>
  );
}
