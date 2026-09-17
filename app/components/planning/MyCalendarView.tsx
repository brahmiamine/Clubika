'use client';

import { useCallback, useEffect, useState } from 'react';
import { SectionCard } from '@/app/components/layout/page-primitives';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Copy, Check, RefreshCw, CalendarDays, ExternalLink, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { useCurrentUser } from '@/app/hooks/useCurrentUser';
import { apiDelete, apiGet, apiPost, describeApiError } from '@/lib/utils/api';

interface IcalLinkStatus {
  hasToken: boolean;
  createdAt: string | null;
}

/**
 * Vue unique de l'abonnement iCal personnel, partagée entre /club et /mon-planning
 * (issue #93).
 *
 * Depuis l'issue #13, seule l'empreinte du jeton est stockée en base : l'URL du
 * flux n'est donc plus récupérable après coup. `GET /api/planning/ical-link` ne
 * renvoie que des métadonnées (date de création) ; le lien complet n'est
 * restitué qu'une seule fois, au moment de la génération/régénération — comme
 * une clé d'API — d'où l'écran « générer / régénérer / révoquer » ci-dessous
 * plutôt qu'un champ toujours rempli.
 */
export function MyCalendarView() {
  const { user } = useCurrentUser();
  const [status, setStatus] = useState<IcalLinkStatus | null>(null);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [revealedUrl, setRevealedUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isRevoking, setIsRevoking] = useState(false);

  const loadStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const data = await apiGet<IcalLinkStatus>('/api/planning/ical-link');
      setStatus(data);
    } catch {
      setStatus(null);
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (user) {
      void loadStatus();
    }
  }, [user, loadStatus]);

  const webcalUrl = revealedUrl.replace(/^https?:\/\//, 'webcal://');
  const googleUrl = revealedUrl
    ? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`
    : '';
  const outlookUrl = revealedUrl
    ? `https://outlook.live.com/calendar/0/addcalendar?url=${encodeURIComponent(webcalUrl)}&name=${encodeURIComponent('Clubika')}`
    : '';

  const handleCopy = async (value = revealedUrl) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Lien copié');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Impossible de copier le lien');
    }
  };

  const handleRegenerate = async () => {
    if (!user) return;
    setIsRegenerating(true);
    try {
      const data = await apiPost<{ feedUrl: string; createdAt: string }>(`/api/users/${user.id}/regenerate-ical-token`);
      setRevealedUrl(data.feedUrl);
      setStatus({ hasToken: true, createdAt: data.createdAt });
      toast.success('Lien généré — copiez-le maintenant, il ne sera plus jamais affiché.');
    } catch (error) {
      toast.error(describeApiError(error, 'Erreur inconnue'));
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleRevoke = async () => {
    if (!user) return;
    setIsRevoking(true);
    try {
      await apiDelete(`/api/users/${user.id}/regenerate-ical-token`);
      setRevealedUrl('');
      setStatus({ hasToken: false, createdAt: null });
      toast.success('Flux iCal révoqué : l’ancien lien ne fonctionne plus.');
    } catch (error) {
      toast.error(describeApiError(error, 'Erreur inconnue'));
    } finally {
      setIsRevoking(false);
    }
  };

  const createdAtLabel = status?.createdAt
    ? new Date(status.createdAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
    : null;

  return (
        <SectionCard
          icon={<CalendarDays />}
          title="Mon calendrier"
          description="Votre abonnement iCal personnel se met à jour automatiquement quand vos affectations changent."
          contentClassName="space-y-4"
        >
            {/* Issue #13 : un fournisseur de calendrier tiers (Google, Outlook, Apple…) reçoit
                et conserve une copie de vos événements dès que vous vous abonnez avec ce lien. */}
            <p className="text-xs text-muted-foreground">
              En vous abonnant, l’application de calendrier que vous utilisez (Google, Outlook, Apple…)
              interroge régulièrement ce lien et en conserve une copie chez elle. Ne le partagez pas :
              quiconque le possède peut voir vos événements et votre rôle.
            </p>

            {isLoadingStatus ? (
              <p className="text-sm text-muted-foreground">Chargement…</p>
            ) : revealedUrl ? (
              <>
                <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                  Ce lien ne sera plus jamais affiché : copiez-le maintenant.
                </p>
                <div className="flex items-center gap-2">
                  <Input value={revealedUrl} readOnly className="font-mono text-xs" />
                  <Button type="button" variant="outline" size="icon" onClick={() => handleCopy()}>
                    {copied ? <Check className="h-4 w-4 text-green-600 dark:text-green-400" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <Button variant="outline" asChild><a href={googleUrl} target="_blank" rel="noreferrer">Google <ExternalLink className="ml-2 h-4 w-4" /></a></Button>
                  <Button variant="outline" asChild><a href={outlookUrl} target="_blank" rel="noreferrer">Outlook <ExternalLink className="ml-2 h-4 w-4" /></a></Button>
                  <Button variant="outline" onClick={() => handleCopy(webcalUrl)}>Copier webcal</Button>
                </div>
              </>
            ) : status?.hasToken ? (
              <p className="text-sm">
                Flux actif{createdAtLabel ? ` — créé le ${createdAtLabel}` : ''}. Régénérez-le pour récupérer un
                lien à copier (l’ancien cessera de fonctionner) ou révoquez-le.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">Aucun flux iCal actif pour le moment.</p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={handleRegenerate} disabled={isRegenerating || !user}>
                <RefreshCw className={`mr-2 h-4 w-4 ${isRegenerating ? 'animate-spin' : ''}`} />
                {status?.hasToken ? 'Régénérer le lien' : 'Générer un lien'}
              </Button>
              {status?.hasToken && (
                <Button variant="outline" onClick={handleRevoke} disabled={isRevoking || !user}>
                  <ShieldOff className="mr-2 h-4 w-4" /> Révoquer
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Régénérer ou révoquer le lien invalide immédiatement l’ancienne URL. Utilisez-le si votre abonnement personnel a été partagé par erreur.</p>
        </SectionCard>
  );
}
