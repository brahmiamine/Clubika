'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { PlateauxData } from '@/types/match';
import { apiGet } from '@/lib/utils/api';
import type { ResourceReloadOptions } from './resource-reload';

export function usePlateaux() {
  const [data, setData] = useState<PlateauxData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPlateaux = useCallback(async (opts?: ResourceReloadOptions) => {
    try {
      if (!opts?.silent) setIsLoading(true);
      setError(null);
      // Ajouter un timestamp pour éviter le cache
      const response = await apiGet<PlateauxData>(`/api/plateaux?t=${Date.now()}`);
      setData(response);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement des plateaux';
      setError(errorMessage);
      logError('app.unhandled', 'Error loading plateaux:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlateaux();
  }, [loadPlateaux]);

  return {
    data,
    isLoading,
    error,
    reload: loadPlateaux,
  };
}
