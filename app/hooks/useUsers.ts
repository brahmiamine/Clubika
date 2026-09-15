'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/utils/api';
import type { ClubAccessRole, PlanningFunction } from '@/lib/auth/roles';

export interface ManagedUser {
  id: number;
  email: string;
  nom: string;
  accessRole: ClubAccessRole;
  planningFunctions: PlanningFunction[];
  active: boolean;
  telephone: string | null;
  /** Date d'activation du compte ; `null` = profil de dirigeant sans accès (issue #204). */
  claimedAt: string | null;
  /** Vrai si le profil a été activé et peut se connecter. */
  hasAccess: boolean;
  createdAt: string;
  updatedAt: string;
}

interface UsersData {
  users: ManagedUser[];
}

export function useUsers() {
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const data = await apiGet<UsersData>('/api/users');
      setUsers(data.users || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement des utilisateurs';
      setError(errorMessage);
      logError('app.unhandled', 'Error loading users:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  return {
    users,
    isLoading,
    error,
    reload: loadUsers,
  };
}
