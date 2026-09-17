'use client';

import { useEffect, useState } from 'react';
import { BarChart3, Info, Scale } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { PageContainer, PageHeader, StatCard } from '@/app/components/layout/page-primitives';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet } from '@/lib/utils/api';
import { toast } from 'sonner';

interface Analytics {
  events: number;
  requiredRoles: number;
  missingRoles: number;
  assignments: number;
  respondedAssignments: number;
  acceptanceRate: number;
  attendanceRate: number;
  averageResponseDelayMinutes: number | null;
  replacementRate: number;
  declineRate: number;
  missingCoverageRate: number;
  fairnessCoefficient: number;
  // Vue nominative volontairement minimale (issue #16) : seul le nombre d'affectations
  // par personne est conservé — il suffit à équilibrer la charge du planning. Les refus,
  // présences et absences individuels ne sont plus renvoyés par l'API ; leurs équivalents
  // globaux (acceptanceRate, attendanceRate, declineRate...) restent disponibles ci-dessus.
  workload: Array<{
    identity: string;
    nom: string;
    assignments: number;
  }>;
  analyzedPeriod: { days: number; from: string; to: string };
}

export default function PlanningStatisticsPage() {
  const [data, setData] = useState<Analytics | null>(null);

  useEffect(() => {
    apiGet<Analytics>('/api/planning/analytics')
      .then(setData)
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Impossible de charger les statistiques'));
  }, []);

  return (
    <PageContainer>
        <PageHeader
          icon={<BarChart3 />}
          title="Statistiques planning"
          description="Acceptation, présence, délais, couverture et équité de charge."
        />
        {!data ? <LoadingSpinner size={44} text="Calcul des statistiques..." className="py-20" /> : (
          <>
            <p className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Statistiques réservées aux administrateurs du club, calculées sur les{' '}
                {data.analyzedPeriod.days} derniers jours (depuis le{' '}
                {new Date(data.analyzedPeriod.from).toLocaleDateString('fr-FR')}) afin de suivre la
                couverture et l&apos;équité de charge du planning — jamais pour classer les
                personnes entre elles. Par personne, seul le nombre d&apos;affectations est
                affiché ; les refus, présences et absences individuels ne sont pas exposés.
              </span>
            </p>
            <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {[
                ['Acceptation', `${data.acceptanceRate.toFixed(1)} %`],
                ['Présence', `${data.attendanceRate.toFixed(1)} %`],
                ['Remplacements', `${data.replacementRate.toFixed(1)} %`],
                ['Taux de refus', `${data.declineRate.toFixed(1)} %`],
                ['Couverture manquante', `${data.missingCoverageRate.toFixed(1)} %`],
                ['Délai moyen', data.averageResponseDelayMinutes === null ? '—' : `${Math.round(data.averageResponseDelayMinutes)} min`],
                ['Affectations', data.assignments],
                ['Événements', data.events],
                ['Équité', `${Math.round(data.fairnessCoefficient * 100)} / 100`],
              ].map(([label, value]) => (
                <StatCard key={String(label)} label={label} value={String(value)} />
              ))}
            </section>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Scale className="h-4 w-4" /> Répartition de la charge</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.workload.length === 0 ? <p className="text-sm text-muted-foreground">Aucune affectation disponible.</p> : data.workload.map((item) => (
                  <div key={item.identity} className="grid gap-2 rounded-lg border p-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center">
                    <strong>{item.nom}</strong>
                    <span className="text-muted-foreground">{item.assignments} affectation(s)</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </>
        )}
    </PageContainer>
  );
}
