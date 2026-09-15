'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/utils/api';

export interface Club {
  nom: string;
  logo: string;
}

export interface ClubsData {
  clubs: Club[];
}

export function useClubs() {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadClubs = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await apiGet<ClubsData>('/api/clubs');
      setClubs(data.clubs || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement des clubs';
      setError(errorMessage);
      logError('app.unhandled', 'Error loading clubs:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadClubs();
  }, [loadClubs]);

  return {
    clubs,
    isLoading,
    error,
    reload: loadClubs,
  };
}
