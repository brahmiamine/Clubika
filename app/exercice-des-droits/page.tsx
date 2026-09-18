'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { toast } from 'sonner';

const TYPES = [
  { value: 'access', label: 'Accès' },
  { value: 'portability', label: 'Portabilité' },
  { value: 'rectification', label: 'Rectification' },
  { value: 'erasure', label: 'Effacement' },
  { value: 'restriction', label: 'Restriction' },
  { value: 'opposition', label: 'Opposition' },
];

export default function PublicPrivacyRightsPage() {
  const [clubId, setClubId] = useState('');
  const [email, setEmail] = useState('');
  const [type, setType] = useState('access');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch('/api/public/privacy-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clubId, email, type }),
      });
      const data = await response.json() as { error?: string; receiptId?: string; legalNotice?: string };
      if (!response.ok) {
        toast.error(data.error || 'Envoi impossible');
        return;
      }
      setReceipt(data.receiptId ?? 'enregistré');
      setNotice(data.legalNotice ?? '');
      toast.success('Demande transmise');
    } catch {
      toast.error('Envoi impossible');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <CardHeader>
        <CardTitle>Exercer vos droits</CardTitle>
        <CardDescription>
          Canal pour une personne avec ou sans compte. Nous ne demandons que l’identifiant du club, un e-mail de contact et le type de demande — pas de pièce d’identité numérisée.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="clubId">Identifiant du club</Label>
            <Input id="clubId" value={clubId} onChange={(e) => setClubId(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">E-mail de contact</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="type">Type de demande</Label>
            <select id="type" className="h-10 w-full rounded-md border px-3 text-sm" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
          <Button type="submit" disabled={busy}>{busy ? 'Envoi…' : 'Envoyer'}</Button>
        </form>
        {receipt && (
          <p className="mt-4 text-sm">Référence : {receipt}</p>
        )}
        {notice && <p className="mt-2 text-xs text-muted-foreground">{notice}</p>}
        <p className="mt-6 text-sm"><Link className="underline" href="/login">J’ai déjà un compte</Link>
          {' · '}
          <Link className="underline" href="/confidentialite">Confidentialité</Link>
        </p>
      </CardContent>
    </AuthShell>
  );
}
