'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/utils/api';
import { OfficielIndisponibilite } from '@/lib/utils/officiel-availability';

export interface Encadrant {
  id: number;
    nom: string;
    telephone?: string;
    indisponibilites?: OfficielIndisponibilite[];
}

interface EncadrantsData {
    encadrants: Encadrant[];
}

export function useEncadrants() {
    const [encadrants, setEncadrants] = useState<Encadrant[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadEncadrants = useCallback(async () => {
        try {
            setIsLoading(true);
            setError(null);
            const data = await apiGet<EncadrantsData>('/api/encadrants');
            setEncadrants(data.encadrants || []);
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement';
            setError(errorMessage);
            logError('app.unhandled', 'Erreur lors du chargement des encadrants:', err);
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        loadEncadrants();
    }, [loadEncadrants]);

    return {
        encadrants,
        isLoading,
        error,
        reload: loadEncadrants,
    };
}
