'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { SectionCard } from '@/app/components/layout/page-primitives';
import { apiGet, apiPatch, apiPost } from '@/lib/utils/api';
import { toast } from 'sonner';

interface PrivacyState {
  legalNotice: string;
  telephone: string | null;
  email: string;
  processingRestrictedAt: string | null;
  processingOpposedAt: string | null;
  requests: Array<{ id: string; type: string; status: string; createdAt: string; decisionCode: string | null }>;
}

export function PrivacyRightsView() {
  const [data, setData] = useState<PrivacyState | null>(null);
  const [telephone, setTelephone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadHref, setDownloadHref] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await apiGet<PrivacyState>('/api/me/privacy');
    setData(next);
    setTelephone(next.telephone ?? '');
    setEmail(next.email);
  }, []);

  useEffect(() => { void load().catch(() => toast.error('Impossible de charger vos droits')); }, [load]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Action impossible');
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionCard
      icon={<Shield />}
      title="Vos données et vos droits"
      description="Rectification, export, restriction et demandes suivies. Aucune décision juridique n’est automatisée."
      contentClassName="space-y-5"
    >
      <p className="text-sm text-muted-foreground">{data?.legalNotice}</p>
      {(data?.processingRestrictedAt || data?.processingOpposedAt) && (
        <p className="text-sm rounded-md border border-amber-300 bg-amber-50 px-3 py-2">
          Un administrateur a enregistré une restriction ou une opposition : les notifications externes non essentielles sont bloquées. Votre compte et ce formulaire restent disponibles.
        </p>
      )}

      <div className="space-y-2">
        <Label>Téléphone</Label>
        <Input value={telephone} onChange={(e) => setTelephone(e.target.value)} />
        <Button
          disabled={busy !== null}
          onClick={() => run('phone', async () => {
            await apiPatch('/api/me/privacy/contact', { telephone });
            toast.success('Téléphone mis à jour');
          })}
        >
          Enregistrer le téléphone
        </Button>
      </div>

      <div className="space-y-2">
        <Label>Nouvel e-mail (vérification requise)</Label>
        <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Button
          disabled={busy !== null}
          onClick={() => run('email', async () => {
            const result = await apiPatch<{ confirmToken?: string }>('/api/me/privacy/contact', { email });
            toast.success('Vérifiez votre nouvelle adresse pour confirmer le changement.');
            if (result.confirmToken) {
              toast.message(`Jeton de confirmation (hors production) : ${result.confirmToken}`);
            }
          })}
        >
          Demander le changement d’e-mail
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => run('export', async () => {
            const result = await apiPost<{ downloadPath: string; token: string }>('/api/me/privacy/export', {});
            setDownloadHref(`${result.downloadPath}?format=json`);
            toast.success('Export prêt. Le lien expire rapidement et ne peut être utilisé qu’une fois.');
          })}
        >
          Télécharger mes données
        </Button>
        {downloadHref && (
          <a className="text-sm underline self-center" href={downloadHref}>Lien JSON éphémère</a>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {(['access', 'erasure', 'restriction', 'opposition'] as const).map((type) => (
          <Button
            key={type}
            variant="outline"
            disabled={busy !== null}
            onClick={() => run(type, async () => {
              await apiPost('/api/me/privacy', { type });
              toast.success('Demande enregistrée. Un administrateur la traitera.');
            })}
          >
            Demander : {type}
          </Button>
        ))}
      </div>

      <div>
        <h3 className="font-semibold mb-2">Demandes déjà déposées</h3>
        <ul className="text-sm space-y-1">
          {(data?.requests ?? []).map((item) => (
            <li key={item.id}>{item.type} — {item.status}{item.decisionCode ? ` (${item.decisionCode})` : ''}</li>
          ))}
          {data?.requests.length === 0 && <li className="text-muted-foreground">Aucune demande.</li>}
        </ul>
      </div>
    </SectionCard>
  );
}
