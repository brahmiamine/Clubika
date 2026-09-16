'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { FileWarning, ShieldAlert } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { PageContainer, PageHeader, SectionCard, StatusPill } from '@/app/components/layout/page-primitives';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet, apiPost } from '@/lib/utils/api';

interface Snapshot {
  notice: string;
  club: { id: string; name: string; active: boolean };
  offboarding: {
    status: string;
    frozenAt: string | null;
    retentionUntil: string | null;
    purgedAt: string | null;
    legalHold: {
      active: boolean;
      motive: string | null;
      scope: string | null;
      expiresAt: string | null;
    };
  };
  inventory: Array<{ id: string; label: string; scanned: number | null; blob?: boolean; documentedOnly?: boolean }>;
  processors: Array<{ id: string; label: string; status: string; instructedAt: string | null; responseAt: string | null }>;
  certificate: Record<string, unknown> | null;
}

export default function ClubOffboardingPage() {
  const params = useParams<{ clubId: string }>();
  const clubId = decodeURIComponent(String(params.clubId ?? ''));
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [retentionUntil, setRetentionUntil] = useState('');
  const [confirmClubId, setConfirmClubId] = useState('');
  const [holdMotive, setHoldMotive] = useState('instruction_humaine');
  const [holdExpires, setHoldExpires] = useState('');

  const load = useCallback(async () => {
    const data = await apiGet<Snapshot>(`/api/plateforme/clubs/${encodeURIComponent(clubId)}/offboarding`);
    setSnapshot(data);
  }, [clubId]);

  useEffect(() => {
    load()
      .catch((error) => toast.error(error instanceof Error ? error.message : 'Impossible de charger l’offboarding'))
      .finally(() => setLoading(false));
  }, [load]);

  const run = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    try {
      const result = await apiPost<{ snapshot?: Snapshot; token?: string; downloadPath?: string; report?: { dryRun: boolean } }>(
        `/api/plateforme/clubs/${encodeURIComponent(clubId)}/offboarding`,
        body,
      );
      if (result.snapshot) setSnapshot(result.snapshot);
      else await load();
      if (result.token && result.downloadPath) {
        window.location.assign(result.downloadPath);
      }
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Action impossible');
    } finally {
      setBusy(false);
    }
  };

  if (loading || !snapshot) {
    return (
      <PageContainer>
        <LoadingSpinner size={32} text="Chargement..." className="py-16" />
      </PageContainer>
    );
  }

  const status = snapshot.offboarding.status;

  return (
    <PageContainer>
      <PageHeader
        title={`Fin de contrat — ${snapshot.club.name}`}
        description={snapshot.notice}
        actions={(
          <Button asChild variant="outline" size="sm">
            <Link href="/plateforme">Retour clubs</Link>
          </Button>
        )}
      />

      <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
        <ShieldAlert className="h-5 w-5 shrink-0" />
        <p>{snapshot.notice}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard icon={<FileWarning />} title="État">
          <div className="flex flex-wrap gap-2 mb-3">
            {status === 'frozen' && <StatusPill tone="warning">Gelé</StatusPill>}
            {status === 'purged' && <StatusPill tone="danger">Supprimé</StatusPill>}
            {status === 'none' && <StatusPill tone="neutral">Actif</StatusPill>}
            {snapshot.offboarding.legalHold.active && <StatusPill tone="danger">Legal hold</StatusPill>}
          </div>
          <p className="font-mono text-sm text-muted-foreground mb-4">{snapshot.club.id}</p>
          <p className="text-sm text-muted-foreground">
            Rétention produit : {snapshot.offboarding.retentionUntil ?? 'non définie (override humain requis pour purger)'}
          </p>
          <div className="mt-4 space-y-3">
            {status === 'none' && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="retention">Date de rétention produit (optionnelle)</Label>
                  <Input id="retention" type="datetime-local" value={retentionUntil} onChange={(event) => setRetentionUntil(event.target.value)} />
                </div>
                <Button disabled={busy} onClick={() => run({ action: 'freeze', retentionUntil: retentionUntil ? new Date(retentionUntil).toISOString() : null }, 'Club gelé')}>
                  Geler le club
                </Button>
              </>
            )}
            {status === 'frozen' && !snapshot.offboarding.legalHold.active && (
              <Button variant="outline" disabled={busy} onClick={() => run({ action: 'cancel-freeze' }, 'Gel annulé')}>
                Annuler le gel
              </Button>
            )}
            {status !== 'purged' && (
              <Button variant="outline" disabled={busy} onClick={() => run({ action: 'export' }, 'Export prêt')}>
                Générer la restitution (jeton unique 15 min)
              </Button>
            )}
          </div>
        </SectionCard>

        <SectionCard title="Legal hold">
          {snapshot.offboarding.legalHold.active ? (
            <div className="space-y-3">
              <p className="text-sm">Motif : {snapshot.offboarding.legalHold.motive} · {snapshot.offboarding.legalHold.scope}</p>
              <p className="text-sm text-muted-foreground">Expire : {snapshot.offboarding.legalHold.expiresAt}</p>
              <Button variant="outline" disabled={busy} onClick={() => run({ action: 'clear-legal-hold' }, 'Legal hold levé')}>
                Lever le legal hold
              </Button>
            </div>
          ) : status !== 'purged' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="hold-motive">Motif</Label>
                <select
                  id="hold-motive"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={holdMotive}
                  onChange={(event) => setHoldMotive(event.target.value)}
                >
                  <option value="instruction_humaine">Instruction humaine</option>
                  <option value="litige">Litige</option>
                  <option value="controle_autorite">Contrôle d’autorité</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="hold-expires">Expiration</Label>
                <Input id="hold-expires" type="datetime-local" value={holdExpires} onChange={(event) => setHoldExpires(event.target.value)} />
              </div>
              <Button
                disabled={busy || !holdExpires}
                onClick={() => run({
                  action: 'legal-hold',
                  motive: holdMotive,
                  scope: 'full_tenant',
                  expiresAt: new Date(holdExpires).toISOString(),
                }, 'Legal hold posé')}
              >
                Poser un legal hold
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Club déjà supprimé.</p>
          )}
        </SectionCard>
      </div>

      <SectionCard title="Inventaire" className="mt-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-2 pr-3">Stockage</th>
                <th className="py-2">Lignes</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.inventory.map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="py-2 pr-3">
                    {row.label}
                    {row.blob ? ' · BLOB' : ''}
                    {row.documentedOnly ? ' · documenté' : ''}
                  </td>
                  <td className="py-2 font-mono">{row.scanned ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Sous-traitants" className="mt-4">
        <div className="space-y-3">
          {snapshot.processors.map((processor) => (
            <div key={processor.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
              <div>
                <p className="font-medium">{processor.label}</p>
                <p className="text-xs text-muted-foreground">{processor.status}</p>
              </div>
              {status !== 'none' && (
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ action: 'ack-processor', processorId: processor.id, status: 'acknowledged' }, 'Réponse enregistrée')}>
                    Accusé
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => run({ action: 'ack-processor', processorId: processor.id, status: 'not_applicable' }, 'Marqué N/A')}>
                    N/A
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </SectionCard>

      {status === 'frozen' && (
        <SectionCard title="Suppression" className="mt-4">
          <p className="text-sm text-muted-foreground mb-3">
            Dry-run d’abord, puis suppression réelle en saisissant l’identifiant du club. Aucune donnée d’un autre tenant n’est touchée.
          </p>
          <div className="flex flex-wrap gap-2 mb-3">
            <Button disabled={busy} variant="outline" onClick={() => run({ action: 'purge', dryRun: true }, 'Dry-run terminé')}>
              Dry-run
            </Button>
          </div>
          <div className="space-y-2 max-w-md">
            <Label htmlFor="confirm-id">Confirmer l’identifiant</Label>
            <Input id="confirm-id" value={confirmClubId} onChange={(event) => setConfirmClubId(event.target.value)} />
            <Button
              disabled={busy || confirmClubId !== snapshot.club.id}
              variant="destructive"
              onClick={() => run({
                action: 'purge',
                dryRun: false,
                overrideRetention: !snapshot.offboarding.retentionUntil,
                confirmClubId,
              }, 'Suppression exécutée')}
            >
              Supprimer définitivement
            </Button>
          </div>
        </SectionCard>
      )}

      {snapshot.certificate && (
        <SectionCard title="Certificat" className="mt-4">
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(snapshot.certificate, null, 2)}</pre>
        </SectionCard>
      )}
    </PageContainer>
  );
}
