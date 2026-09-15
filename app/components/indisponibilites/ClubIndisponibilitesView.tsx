'use client';

import { useCallback, useEffect, useState } from 'react';
import { ClubIndisponibilitesList } from '@/app/components/indisponibilites/ClubIndisponibilitesList';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet, apiPost } from '@/lib/utils/api';
import type { ClubIndisponibiliteRow } from '@/lib/indisponibilites/club-listing';
import { toast } from 'sonner';

export function ClubIndisponibilitesView() {
  const [items, setItems] = useState<ClubIndisponibiliteRow[] | null>(null);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ items: ClubIndisponibiliteRow[] }>('/api/club/indisponibilites');
      setItems(data.items);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de charger les indisponibilités');
      setItems([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onReview = async (row: ClubIndisponibiliteRow, decision: 'accepted' | 'rejected', reviewCode?: string) => {
    setReviewingId(row.id);
    try {
      await apiPost('/api/club/indisponibilites/review', {
        userId: row.userId,
        indisponibiliteId: row.indisponibiliteId,
        decision,
        reviewCode: reviewCode ?? null,
      });
      toast.success(decision === 'accepted' ? 'Indisponibilité acceptée' : 'Indisponibilité refusée');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Décision impossible');
    } finally {
      setReviewingId(null);
    }
  };

  if (items === null) {
    return <LoadingSpinner size={44} text="Chargement des indisponibilités..." className="py-20" />;
  }

  return <ClubIndisponibilitesList items={items} onReview={onReview} reviewingId={reviewingId} />;
}
