'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { apiPost } from '@/lib/utils/api';
import { toast } from 'sonner';

export default function ResetPasswordPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (password.length < 12) {
      toast.error('Le mot de passe doit contenir au moins 12 caractères');
      return;
    }
    if (password !== confirmPassword) {
      toast.error('Les mots de passe ne correspondent pas');
      return;
    }

    setLoading(true);
    try {
      await apiPost('/api/auth/password-reset/confirm', { token: params.token, newPassword: password });
      toast.success('Mot de passe réinitialisé');
      router.push('/login');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Réinitialisation impossible');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
        <CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" /> Nouveau mot de passe</CardTitle><CardDescription>Ce lien est temporaire et ne peut être utilisé qu’une fois.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2"><Label>Nouveau mot de passe</Label><Input type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} /></div>
          <div className="space-y-2"><Label>Confirmer</Label><Input type="password" minLength={12} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></div>
          <Button className="w-full" onClick={submit} disabled={loading}>{loading ? 'Enregistrement...' : 'Changer le mot de passe'}</Button>
          <Button variant="ghost" asChild className="w-full"><Link href="/login">Annuler</Link></Button>
        </CardContent>
    </AuthShell>
  );
}
