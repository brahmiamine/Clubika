'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/utils/api';
import type { ClubAccessRole, PlanningFunction } from '@/lib/auth/roles';

export interface Invitation {
  id: string;
  email: string | null;
  accessRole: ClubAccessRole;
  planningFunctions: PlanningFunction[];
  personNom: string | null;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

interface InvitationsData {
  invitations: Invitation[];
}

export function useInvitations() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadInvitations = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await apiGet<InvitationsData>('/api/invitations');
      setInvitations(data.invitations || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement des invitations';
      setError(errorMessage);
      logError('app.unhandled', 'Error loading invitations:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvitations();
  }, [loadInvitations]);

  return {
    invitations,
    isLoading,
    error,
    reload: loadInvitations,
  };
}
