'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { MatchesData } from '@/types/match';
import { apiGet } from '@/lib/utils/api';
import type { ResourceReloadOptions } from './resource-reload';

/**
 * Hook personnalisé pour gérer les matchs
 */
export function useMatches() {
  const [matchesData, setMatchesData] = useState<MatchesData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMatches = useCallback(async (opts?: ResourceReloadOptions) => {
    try {
      if (!opts?.silent) setIsLoading(true);
      setError(null);
      const data = await apiGet<MatchesData>('/api/matches');
      setMatchesData(data);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement des matchs';
      setError(errorMessage);
      logError('app.unhandled', 'Error loading matches:', err);
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
