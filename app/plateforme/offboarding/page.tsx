'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { FileWarning } from 'lucide-react';
import { PageContainer, PageHeader, SectionCard, StatusPill } from '@/app/components/layout/page-primitives';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet } from '@/lib/utils/api';

interface OffboardingRow {
  id: string;
  name: string;
  offboarding: {
    status: string;
    legalHold: { active: boolean };
    frozenAt: string | null;
    purgedAt: string | null;
  };
}

export default function OffboardingListPage() {
  const [clubs, setClubs] = useState<OffboardingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiGet<{ clubs: OffboardingRow[] }>('/api/plateforme/offboarding')
      .then((data) => setClubs(data.clubs))
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Impossible de charger l’offboarding'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <PageContainer>
      <PageHeader
        title="Fin de contrat"
        description="Gel, restitution et suppression des clubs. Les délais affichés sont des paramètres produit."
      />
      <SectionCard icon={<FileWarning />} title="Clubs en offboarding">
        {loading ? (
          <LoadingSpinner size={32} text="Chargement..." className="py-10" />
        ) : clubs.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6">Aucun club gelé, en legal hold ou supprimé.</p>
        ) : (
          <div className="space-y-2">
            {clubs.map((club) => (
              <Link
                key={club.id}
                href={`/plateforme/offboarding/${encodeURIComponent(club.id)}`}
                className="flex items-center justify-between rounded-xl border bg-card p-3 hover:bg-secondary-soft"
              >
                <div>
                  <p className="font-medium">{club.name}</p>
                  <p className="font-mono text-sm text-muted-foreground">{club.id}</p>
                </div>
                <div className="flex items-center gap-2">
                  {club.offboarding.legalHold.active && <StatusPill tone="danger">Legal hold</StatusPill>}
                  {club.offboarding.status === 'frozen' && <StatusPill tone="warning">Gelé</StatusPill>}
                  {club.offboarding.status === 'purged' && <StatusPill tone="danger">Supprimé</StatusPill>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </SectionCard>
    </PageContainer>
  );
}
