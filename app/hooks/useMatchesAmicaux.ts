'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { MatchesAmicauxData } from '@/types/match';
import { apiGet } from '@/lib/utils/api';
import type { ResourceReloadOptions } from './resource-reload';

export function useMatchesAmicaux() {
  const [matchesData, setMatchesData] = useState<MatchesAmicauxData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMatches = useCallback(async (opts?: ResourceReloadOptions) => {
    try {
      if (!opts?.silent) setIsLoading(true);
      setError(null);
      // Ajouter un timestamp pour éviter le cache
      const data = await apiGet<MatchesAmicauxData>(`/api/matches-amicaux?t=${Date.now()}`);
      setMatchesData(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement des matchs amicaux';
      setError(errorMessage);
      logError('app.unhandled', 'Error loading matches amicaux:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMatches();
  }, [loadMatches]);

  return {
    matchesData,
    isLoading,
    error,
    reload: loadMatches,
  };
}
