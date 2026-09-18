'use client';

import { useCallback, useEffect, useState } from 'react';
import { Link2, Trash2 } from 'lucide-react';
import { Badge } from '@/app/components/ui/badge';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { PageContainer, PageHeader } from '@/app/components/layout/page-primitives';
import { PublicShareLinkRow } from '@/app/components/planning/PublicShareLinkRow';
import { apiDelete, apiGet, apiPost } from '@/lib/utils/api';
import { formatIsoDate } from '@/lib/utils/date';
import { toast } from 'sonner';

type EventType = 'officiel' | 'amical' | 'entrainement' | 'plateau';

interface ShareItem {
  id: string;
  expiresAt: string;
  scope: { eventTypes: EventType[]; fromDate: string | null; toDate: string | null };
  createdAt: string;
  expired: boolean;
}

export default function PlanningSharingPage() {
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [expiryDays, setExpiryDays] = useState(7);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [eventTypes, setEventTypes] = useState<EventType[]>(['officiel', 'amical', 'entrainement', 'plateau']);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [quickUrl, setQuickUrl] = useState<string | null>(null);
  const [quickLoading, setQuickLoading] = useState(false);

  const load = useCallback(() => {
    apiGet<{ shares: ShareItem[] }>('/api/planning/shares')
      .then((result) => setShares(result.shares))
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Impossible de charger les partages'));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (type: EventType) => {
    setEventTypes((current) => current.includes(type) ? current.filter((item) => item !== type) : [...current, type]);
  };

  const create = async () => {
    try {
      const result = await apiPost<{ share: { path: string } }>('/api/planning/shares', {
        expiryDays,
        fromDate: fromDate || null,
        toDate: toDate || null,
        eventTypes,
      });
      const url = `${window.location.origin}${result.share.path}`;
      setLastUrl(url);
      toast.success('Lien public créé');
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de créer le partage');
    }
  };

  const createQuick = async () => {
    setQuickLoading(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const result = await apiPost<{ share: { path: string } }>('/api/planning/shares', {
        expiryDays: 30,
        fromDate: today,
        toDate: null,
        eventTypes: ['officiel', 'amical', 'entrainement', 'plateau'],
      });
      const url = `${window.location.origin}${result.share.path}`;
      setQuickUrl(url);
      toast.success('Lien public créé');
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de créer le partage');
    } finally {
      setQuickLoading(false);
    }
  };

  const revoke = async (id: string) => {
    try {
      await apiDelete(`/api/planning/shares?id=${encodeURIComponent(id)}`);
      toast.success('Partage révoqué');
      load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de révoquer le partage');
    }
  };

  return (
    <PageContainer>
        <PageHeader
          icon={<Link2 />}
          title="Partager le planning"
          description="Liens publics en lecture seule, expirables et sans données personnelles."
        />
        <Card>
          <CardHeader><CardTitle className="text-base">Lien du planning en cours</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">Génère un lien public en lecture seule couvrant tous les événements à venir (valable 30 jours).</p>
            <Button onClick={createQuick} disabled={quickLoading}>
              <Link2 className="mr-2 h-4 w-4" />
              {quickLoading ? 'Génération…' : 'Générer un lien public'}
            </Button>
            {quickUrl && <PublicShareLinkRow url={quickUrl} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Nouveau partage personnalisé</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">Durée (jours)<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" type="number" min={1} max={90} value={expiryDays} onChange={(event) => setExpiryDays(Number(event.target.value))} /></label>
              <label className="text-sm">Du<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
              <label className="text-sm">Au<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
            </div>
            <div className="flex flex-wrap gap-2">
              {(['officiel', 'amical', 'entrainement', 'plateau'] as EventType[]).map((type) => (
                <Button key={type} type="button" size="sm" variant={eventTypes.includes(type) ? 'default' : 'outline'} onClick={() => toggle(type)}>{type}</Button>
              ))}
            </div>
            <Button onClick={create} disabled={!eventTypes.length}>Créer le lien public</Button>
            {lastUrl && <PublicShareLinkRow url={lastUrl} />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Liens existants</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {shares.map((share) => (
              <div key={share.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                <div><div className="flex items-center gap-2"><strong>{share.scope.eventTypes.join(', ')}</strong><Badge variant={share.expired ? 'destructive' : 'outline'}>{share.expired ? 'Expiré' : 'Actif'}</Badge></div><p className="text-xs text-muted-foreground">Expire le {new Date(share.expiresAt).toLocaleString('fr-FR')}{share.scope.fromDate || share.scope.toDate ? ` · ${share.scope.fromDate ? formatIsoDate(share.scope.fromDate) : '…'} → ${share.scope.toDate ? formatIsoDate(share.scope.toDate) : '…'}` : ''}</p></div>
                <Button size="sm" variant="default" onClick={() => revoke(share.id)}><Trash2 className="mr-2 h-4 w-4" /> Révoquer</Button>
              </div>
            ))}
            {!shares.length && <p className="text-sm text-muted-foreground">Aucun lien créé.</p>}
          </CardContent>
        </Card>
    </PageContainer>
  );
}
