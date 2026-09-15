'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { Building2 } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { toast } from 'sonner';

type Step = 'password' | 'totp' | 'enroll' | 'recovery';

export default function PlatformLoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [step, setStep] = useState<Step>('password');
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();

  const finishLogin = () => {
    toast.success('Connexion réussie');
    router.push('/plateforme');
    router.refresh();
  };

  const handlePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const response = await fetch('/api/plateforme/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await response.json() as {
        error?: string;
        success?: boolean;
        mfaRequired?: boolean;
        mfaEnrollmentRequired?: boolean;
      };
      if (data.mfaEnrollmentRequired) {
        const enroll = await fetch('/api/plateforme/mfa/enroll');
        const enrollBody = await enroll.json() as { error?: string; otpauthUrl?: string; secret?: string };
        if (!enroll.ok) {
          toast.error(enrollBody.error || 'Impossible de préparer le second facteur');
          return;
        }
        setOtpauthUrl(enrollBody.otpauthUrl ?? '');
        setSecret(enrollBody.secret ?? '');
        setStep('enroll');
        return;
      }
      if (data.mfaRequired) {
        setStep('totp');
        return;
      }
      if (response.ok && data.success) {
        finishLogin();
        return;
      }
      toast.error(data.error || 'Email ou mot de passe incorrect');
    } catch {
      toast.error('Une erreur est survenue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const response = await fetch('/api/plateforme/login', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp, recoveryCode: recoveryCode || undefined }),
      });
      const data = await response.json() as { error?: string; success?: boolean };
      if (response.ok && data.success) {
        finishLogin();
        return;
      }
      toast.error(data.error || 'Code invalide');
    } catch {
      toast.error('Une erreur est survenue');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEnroll = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const response = await fetch('/api/plateforme/mfa/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totp }),
      });
      const data = await response.json() as { error?: string; success?: boolean; recoveryCodes?: string[] };
      if (response.ok && data.success) {
        setRecoveryCodes(data.recoveryCodes ?? []);
        setStep('recovery');
        return;
      }
      toast.error(data.error || 'Code invalide');
    } catch {
      toast.error('Une erreur est survenue');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden bg-[#101A35] p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
          backgroundSize: '56px 56px',
        }}
      />
      <div className="relative flex flex-col items-center gap-3.5 text-center">
        <Image src="/branding/clubika-icon.png" alt="" width={44} height={44} className="h-11 w-11" priority />
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[color:var(--gold)]/15 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[color:var(--gold)]">
          <Building2 className="h-3 w-3" />
          Administration plateforme
        </span>
        <p className="text-sm text-white/55">Réservé aux administrateurs de la plateforme Clubika</p>
      </div>

      <Card className="relative w-full max-w-md shadow-2xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-center text-2xl font-bold">
            {step === 'password' && 'Connexion'}
            {step === 'totp' && 'Second facteur'}
            {step === 'enroll' && 'Activer le second facteur'}
            {step === 'recovery' && 'Codes de récupération'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {step === 'password' && (
            <form onSubmit={handlePassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="admin@plateforme.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                  disabled={isLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Mot de passe</Label>
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
              <Button type="submit" className="w-full" disabled={isLoading || !email || !password}>
                {isLoading ? 'Connexion...' : 'Continuer'}
              </Button>
            </form>
          )}

          {step === 'totp' && (
            <form onSubmit={handleTotp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="totp">Code TOTP à 6 chiffres</Label>
                <Input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  disabled={isLoading}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="recovery">Ou code de récupération</Label>
                <Input
                  id="recovery"
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value)}
                  disabled={isLoading}
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading || (!totp && !recoveryCode)}>
                {isLoading ? 'Vérification...' : 'Valider'}
              </Button>
            </form>
          )}

          {step === 'enroll' && (
            <form onSubmit={handleEnroll} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Scannez ce secret TOTP dans votre application d&apos;authentification, puis saisissez un code pour confirmer.
              </p>
              <div className="space-y-2">
                <Label htmlFor="otpauth">URI otpauth</Label>
                <Input id="otpauth" value={otpauthUrl} readOnly className="font-mono text-xs" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="secret">Secret</Label>
                <Input id="secret" value={secret} readOnly className="font-mono text-xs" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="enroll-totp">Code de confirmation</Label>
                <Input
                  id="enroll-totp"
                  inputMode="numeric"
                  value={totp}
                  onChange={(e) => setTotp(e.target.value)}
                  disabled={isLoading}
                />
              </div>
              <Button type="submit" className="w-full" disabled={isLoading || totp.length !== 6}>
                {isLoading ? 'Activation...' : 'Activer'}
              </Button>
            </form>
          )}

          {step === 'recovery' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Conservez ces codes hors ligne. Ils sont hashés côté serveur et affichés une seule fois.
              </p>
              <ul className="font-mono text-sm space-y-1">
                {recoveryCodes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
              <Button className="w-full" onClick={finishLogin}>Accéder à la plateforme</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
