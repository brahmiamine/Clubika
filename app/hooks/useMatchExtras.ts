'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { apiGet, apiPut, describeApiError } from '@/lib/utils/api';
import { pickMatchExtrasWritePayload } from '@/lib/planning/match-extras-write-payload';
import type {
  AssignmentContact,
  Match,
  OfficialMatchAdminOverride,
  PlanningPublicationMeta,
  ScraperSourceStatus,
} from '@/types/match';

export type ContactOfficiel = AssignmentContact;

export interface MatchExtras extends PlanningPublicationMeta {
  id: string;
  confirmed?: boolean;
  arbitreTouche?: ContactOfficiel[];
  contactEncadrants?: ContactOfficiel[];
  contactAccompagnateur?: ContactOfficiel[];
  /** Dernier état brut reçu de la source officielle. Propriété gérée côté serveur. */
  officialSourceSnapshot?: Match;
  /** Champs dont la valeur administrateur prend le pas sur la source officielle. */
  officialAdminOverride?: OfficialMatchAdminOverride | null;
  officialOverrideDetectedAt?: string | null;
  officialOverrideUpdatedAt?: string | null;
  officialOverrideUpdatedByUserId?: number | null;
  officialOverrideUpdatedByUserEmail?: string | null;
  sourceStatus?: ScraperSourceStatus;
  sourceLastSeenAt?: string | null;
  sourceMissingSince?: string | null;
  sourceMissingObservations?: number;
  sourceMissingCancelled?: boolean;
}

export function useMatchExtras(matchId: string | undefined) {
  const [extras, setExtras] = useState<MatchExtras | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadExtras = useCallback(async () => {
    if (!matchId) {
      setExtras(null);
      return;
    }

    try {
      setIsLoading(true);
      setError(null);
      const data = await apiGet<MatchExtras | null>(`/api/matches/${matchId}`);
      setExtras(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement';
      setError(errorMessage);
      logError('app.unhandled', 'Erreur lors du chargement des extras:', err);
    } finally {
      setIsLoading(false);
    }
  }, [matchId]);

  const saveExtras = useCallback(async (extrasData: MatchExtras): Promise<boolean> => {
    if (!matchId) {
      throw new Error('ID de match manquant');
    }

    try {
      setIsLoading(true);
      setError(null);
      const extrasToSave = pickMatchExtrasWritePayload({
        ...extrasData,
        id: matchId,
      });
      await apiPut(`/api/matches/${matchId}`, extrasToSave);
      await loadExtras();
      return true;
    } catch (err) {
      const errorMessage = describeApiError(err, 'Erreur lors de la sauvegarde');
      setError(errorMessage);
      logError('app.unhandled', 'Erreur lors de la sauvegarde:', err);
      // Le formulaire appelant se contente de tester la valeur de retour : sans toast ici,
      // un échec (ex. affectation refusée par la validation serveur) reste invisible pour
      // l'utilisateur, qui voit juste le formulaire rester ouvert sans rien comprendre.
      toast.error(errorMessage);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [matchId, loadExtras]);

  useEffect(() => {
    loadExtras();
  }, [loadExtras]);

  return {
    extras,
    isLoading,
    error,
    reload: loadExtras,
    save: saveExtras,
  };
}
