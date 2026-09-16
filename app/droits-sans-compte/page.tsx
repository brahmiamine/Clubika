'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { CardContent, CardDescription, CardHeader, CardTitle } from '@/app/components/ui/card';
import { AuthShell } from '@/app/components/layout/AuthShell';
import { toast } from 'sonner';
import { PRIVACY_NO_LEGAL_PROMISE, RIGHTS_TYPES, RIGHTS_TYPE_LABELS } from '@/lib/non-account-contacts/constants';

export default function DroitsSansComptePage() {
  const [clubId, setClubId] = useState('');
  const [type, setType] = useState<(typeof RIGHTS_TYPES)[number]>('access');
  const [email, setEmail] = useState('');
  const [telephone, setTelephone] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/public/non-account-rights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clubId,
          type,
          email: email || undefined,
          telephone: telephone || undefined,
        }),
      });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok) {
        toast.error(data.error || 'Demande impossible');
        return;
      }
      setSent(true);
      toast.success(data.message || 'Demande enregistrée');
    } catch {
      toast.error('Une erreur est survenue');
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <CardHeader>
        <CardTitle className="text-center">Droits sans compte</CardTitle>
        <CardDescription className="text-center">
          Accès, rectification, opposition ou effacement pour une fiche enregistrée sans compte.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{PRIVACY_NO_LEGAL_PROMISE}</p>
        {sent ? (
          <p className="text-sm">Votre demande a été enregistrée. Le club la traitera. Aucun délai légal n’est calculé ici.</p>
        ) : (
          <>
            <div className="space-y-2">
              <Label htmlFor="clubId">Identifiant du club</Label>
              <Input id="clubId" value={clubId} onChange={(e) => setClubId(e.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="type">Demande</Label>
              <select
                id="type"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value as (typeof RIGHTS_TYPES)[number])}
              >
                {RIGHTS_TYPES.map((value) => (
                  <option key={value} value={value}>{RIGHTS_TYPE_LABELS[value]}</option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email (optionnel)</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="telephone">Téléphone (optionnel)</Label>
              <Input id="telephone" type="tel" value={telephone} onChange={(e) => setTelephone(e.target.value)} />
            </div>
            <Button className="w-full" onClick={submit} disabled={loading || !clubId || (!email && !telephone)}>
              {loading ? 'Envoi…' : 'Envoyer la demande'}
            </Button>
          </>
        )}
        <Button variant="ghost" asChild className="w-full"><Link href="/login">Retour à la connexion</Link></Button>
      </CardContent>
    </AuthShell>
  );
}
