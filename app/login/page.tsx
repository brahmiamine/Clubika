'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { refreshAppSettingsTheme } from '@/app/hooks/useAppSettings';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { toast } from 'sonner';

interface LoginClubChoice {
  clubId: string;
  clubName: string;
}

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [clubChoices, setClubChoices] = useState<LoginClubChoice[] | null>(null);
  const [selectedClubId, setSelectedClubId] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const { reload } = useCurrentUser();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (clubChoices && !selectedClubId) {
      toast.error('Sélectionnez un club pour continuer');
      return;
    }
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          ...(selectedClubId ? { clubId: selectedClubId } : {}),
        }),
      });

      const data = await response.json() as {
        error?: string;
        redirectTo?: string;
        requiresClubSelection?: boolean;
        clubs?: LoginClubChoice[];
      };

      if (response.status === 409 && data.requiresClubSelection && data.clubs?.length) {
        setClubChoices(data.clubs);
        setSelectedClubId(data.clubs[0]?.clubId ?? '');
        toast.message('Plusieurs clubs correspondent à ces identifiants. Choisissez le vôtre.');
        return;
      }

      if (response.ok) {
        setClubChoices(null);
        setSelectedClubId('');
        toast.success('Connexion réussie');
        // Recharge l'utilisateur courant avant de naviguer : sinon AuthProvider garde
        // le `user` (null) chargé pendant l'écran de login et rebascule vers /login
        // dès la première navigation cliente sur la page suivante.
        await reload();
        // Charge tout de suite le thème (couleurs primaire/secondaire) du club
        // authentifié avant d'arriver sur /club ou /mon-planning.
        await refreshAppSettingsTheme();
        router.push(data.redirectTo || '/club');
      } else {
        toast.error(data.error || 'Email ou mot de passe incorrect');
      }
    } catch {
      toast.error('Une erreur est survenue');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell>
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold text-center">Connexion</CardTitle>
          <CardDescription className="text-center">
            Connectez-vous avec votre compte pour continuer
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="vous@exemple.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                disabled={isLoading}
              />
            </div>
            {clubChoices && (
              <div className="space-y-2">
                <Label htmlFor="club">Club</Label>
                <select
                  id="club"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={selectedClubId}
                  onChange={(e) => setSelectedClubId(e.target.value)}
                  disabled={isLoading}
                  required
                >
                  {clubChoices.map((club) => (
                    <option key={club.clubId} value={club.clubId}>
                      {club.clubName}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="password">Mot de passe</Label>
                <Link href="/mot-de-passe-oublie" className="text-xs text-primary hover:underline">
                  Mot de passe oublié ?
                </Link>
              </div>
              <Input
                id="password"
                type="password"
                placeholder="Votre mot de passe"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={isLoading || !email || !password || (clubChoices !== null && !selectedClubId)}
            >
              {isLoading ? 'Connexion...' : clubChoices ? 'Continuer' : 'Se connecter'}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              <Link href="/exercice-des-droits" className="hover:underline">Exercer vos droits</Link>
              {' · '}
              <Link href="/droits-sans-compte" className="text-primary hover:underline">
                Exercer un droit sans compte
              </Link>
            </p>
          </form>
        </CardContent>
    </AuthShell>
  );
}
