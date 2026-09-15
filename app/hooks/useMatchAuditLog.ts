'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiGet } from '@/lib/utils/api';

export interface MatchAuditLogEntry {
  id: number;
  clubId: string;
  entityType: string;
  entityId: string;
  action: string;
  userId: number | null;
  actorLabel: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  schemaVersion: number;
}

interface AuditLogData {
  entries: MatchAuditLogEntry[];
}

export function useMatchAuditLog(matchId: string | undefined | null) {
  const [entries, setEntries] = useState<MatchAuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    if (!matchId) {
      setEntries([]);
      return;
    }
    try {
      setIsLoading(true);
      setError(null);
      const data = await apiGet<AuditLogData>(`/api/matches/${matchId}/audit-log`);
      setEntries(data.entries || []);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Erreur lors du chargement de l\'historique';
      setError(errorMessage);
      console.error('Error loading match audit log:', err);
    } finally {
      setIsLoading(false);
    }
  }, [matchId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  return {
    entries,
    isLoading,
    error,
    reload: loadEntries,
  };
}
