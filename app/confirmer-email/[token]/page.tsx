'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { Button } from '@/app/components/ui/button';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { toast } from 'sonner';

export default function ConfirmEmailPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/privacy/contact/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: params.token }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        toast.error(data.error || 'Confirmation impossible');
        return;
      }
      toast.success('E-mail confirmé. Reconnectez-vous.');
      router.push('/login');
    } catch {
      toast.error('Confirmation impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <CardHeader>
        <CardTitle>Confirmer le nouvel e-mail</CardTitle>
        <CardDescription>Cette action révoque les sessions et le lien iCal existant.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button onClick={confirm} disabled={busy}>{busy ? 'Confirmation…' : 'Confirmer'}</Button>
      </CardContent>
    </AuthShell>
  );
}
