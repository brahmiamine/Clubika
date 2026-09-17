'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Link2, Trash2 } from 'lucide-react';
import { Badge } from '@/app/components/ui/badge';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { PageContainer, PageHeader } from '@/app/components/layout/page-primitives';
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

const DEFAULT_MAX_EXPIRY_DAYS = 30;

/** Aperçu de l'échéance avant création (issue #14), à partir d'une durée en jours. */
function formatShareExpiryPreview(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '—';
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toLocaleString('fr-FR');
}

/**
 * Fenêtre d'origine d'un lien (issue #14) : différence, en jours, entre sa création
 * et son échéance. Sert uniquement à signaler dans l'administration les liens émis
 * avant la réduction du maximum, jamais à les révoquer ni à les raccourcir.
 */
function originalShareWindowDays(share: Pick<ShareItem, 'createdAt' | 'expiresAt'>): number | null {
  const created = Date.parse(share.createdAt);
  const expires = Date.parse(share.expiresAt);
  if (!Number.isFinite(created) || !Number.isFinite(expires)) return null;
  return Math.round((expires - created) / (24 * 60 * 60 * 1000));
}

export default function PlanningSharingPage() {
  const [shares, setShares] = useState<ShareItem[]>([]);
  const [expiryDays, setExpiryDays] = useState(7);
  const [maxExpiryDays, setMaxExpiryDays] = useState(DEFAULT_MAX_EXPIRY_DAYS);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [eventTypes, setEventTypes] = useState<EventType[]>(['officiel', 'amical', 'entrainement', 'plateau']);
  const [lastUrl, setLastUrl] = useState<string | null>(null);
  const [quickUrl, setQuickUrl] = useState<string | null>(null);
  const [quickLoading, setQuickLoading] = useState(false);

  const load = useCallback(() => {
    apiGet<{ shares: ShareItem[]; maxExpiryDays: number }>('/api/planning/shares')
      .then((result) => {
        setShares(result.shares);
        if (Number.isFinite(result.maxExpiryDays) && result.maxExpiryDays > 0) {
          setMaxExpiryDays(result.maxExpiryDays);
          // Une fenêtre déjà saisie au-dessus du nouveau maximum (issue #14) est
          // ramenée dans les clous plutôt que de rester silencieusement rejetée côté API.
          setExpiryDays((current) => Math.min(current, result.maxExpiryDays));
        }
      })
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
      await navigator.clipboard?.writeText(url);
      toast.success('Lien créé et copié');
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
        expiryDays: maxExpiryDays,
        fromDate: today,
        toDate: null,
        eventTypes: ['officiel', 'amical', 'entrainement', 'plateau'],
      });
      const url = `${window.location.origin}${result.share.path}`;
      setQuickUrl(url);
      await navigator.clipboard?.writeText(url);
      toast.success('Lien public créé et copié');
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
            <p className="text-sm text-muted-foreground">Génère un lien public en lecture seule couvrant tous les événements à venir (valable {maxExpiryDays} jours, expire le {formatShareExpiryPreview(maxExpiryDays)}).</p>
            <Button onClick={createQuick} disabled={quickLoading}>
              <Link2 className="mr-2 h-4 w-4" />
              {quickLoading ? 'Génération…' : 'Générer un lien public'}
            </Button>
            {quickUrl && <div className="flex gap-2 rounded-lg border p-3 text-sm"><span className="min-w-0 flex-1 truncate">{quickUrl}</span><Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(quickUrl)}><Copy className="h-4 w-4" /></Button></div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Nouveau partage personnalisé</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="text-sm">
                Durée (jours, {maxExpiryDays} max.)
                <input
                  className="mt-1 w-full rounded-md border bg-background px-3 py-2"
                  type="number"
                  min={1}
                  max={maxExpiryDays}
                  value={expiryDays}
                  onChange={(event) => setExpiryDays(Number(event.target.value))}
                />
              </label>
              <label className="text-sm">Du<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} /></label>
              <label className="text-sm">Au<input className="mt-1 w-full rounded-md border bg-background px-3 py-2" type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} /></label>
            </div>
            <div className="flex flex-wrap gap-2">
              {(['officiel', 'amical', 'entrainement', 'plateau'] as EventType[]).map((type) => (
                <Button key={type} type="button" size="sm" variant={eventTypes.includes(type) ? 'default' : 'outline'} onClick={() => toggle(type)}>{type}</Button>
              ))}
            </div>
            {/* Échéance affichée avant création (issue #14) : durée maximale réduite à
                {maxExpiryDays} jours, valeur produit configurable, pas une obligation légale. */}
            <p className="text-xs text-muted-foreground">
              Ce lien expirera le <strong>{formatShareExpiryPreview(expiryDays)}</strong> (maximum proposé : {maxExpiryDays} jours).
            </p>
            <Button onClick={create} disabled={!eventTypes.length}>Créer le lien public</Button>
            {lastUrl && <div className="flex gap-2 rounded-lg border p-3 text-sm"><span className="min-w-0 flex-1 truncate">{lastUrl}</span><Button size="sm" variant="outline" onClick={() => navigator.clipboard?.writeText(lastUrl)}><Copy className="h-4 w-4" /></Button></div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Liens existants</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {shares.map((share) => {
              const originalWindowDays = originalShareWindowDays(share);
              const isLegacyWindow = !share.expired && originalWindowDays !== null && originalWindowDays > maxExpiryDays;
              return (
                <div key={share.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <strong>{share.scope.eventTypes.join(', ')}</strong>
                      <Badge variant={share.expired ? 'destructive' : 'outline'}>{share.expired ? 'Expiré' : 'Actif'}</Badge>
                      {isLegacyWindow && (
                        <Badge variant="secondary" title={`Créé avant la réduction du maximum à ${maxExpiryDays} jours : reste valable jusqu'à son échéance d'origine, jamais raccourci rétroactivement.`}>
                          Fenêtre &gt; {maxExpiryDays} j
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">Expire le {new Date(share.expiresAt).toLocaleString('fr-FR')}{share.scope.fromDate || share.scope.toDate ? ` · ${share.scope.fromDate ? formatIsoDate(share.scope.fromDate) : '…'} → ${share.scope.toDate ? formatIsoDate(share.scope.toDate) : '…'}` : ''}</p>
                  </div>
                  <Button size="sm" variant="default" onClick={() => revoke(share.id)}><Trash2 className="mr-2 h-4 w-4" /> Révoquer</Button>
                </div>
              );
            })}
            {!shares.length && <p className="text-sm text-muted-foreground">Aucun lien créé.</p>}
          </CardContent>
        </Card>
    </PageContainer>
  );
}
