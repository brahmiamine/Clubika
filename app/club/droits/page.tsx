'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shield } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { SectionCard } from '@/app/components/layout/page-primitives';
import { apiGet, apiPatch } from '@/lib/utils/api';
import { toast } from 'sonner';

interface PrivacyRequestRow {
  id: string;
  type: string;
  status: string;
  subjectUserId: number | null;
  hasEmailHash: boolean;
  identityVerifiedAt: string | null;
  decisionCode: string | null;
  responseProof: string | null;
  createdAt: string;
}

export default function ClubPrivacyRequestsPage() {
  const [legalNotice, setLegalNotice] = useState('');
  const [requests, setRequests] = useState<PrivacyRequestRow[]>([]);
  const [claimedEmail, setClaimedEmail] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const data = await apiGet<{ legalNotice: string; requests: PrivacyRequestRow[] }>('/api/club/privacy-requests');
    setLegalNotice(data.legalNotice);
    setRequests(data.requests);
  }, []);

  useEffect(() => { void load().catch(() => toast.error('Impossible de charger les demandes')); }, [load]);

  const patch = async (id: string, body: Record<string, unknown>) => {
    try {
      await apiPatch(`/api/club/privacy-requests/${id}`, body);
      toast.success('Demande mise à jour');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Mise à jour impossible');
    }
  };

  return (
    <div className="max-w-4xl space-y-4">
      <SectionCard
        icon={<Shield />}
        title="File des demandes d’exercice des droits"
        description="Décisions humaines uniquement. L’effacement se fait via la fermeture de compte (#11), pas ici."
      >
        <p className="text-sm text-muted-foreground mb-4">{legalNotice}</p>
        <ul className="space-y-4">
          {requests.map((row) => (
            <li key={row.id} className="rounded-xl border p-4 space-y-2">
              <p className="font-medium">{row.type} · {row.status}</p>
              <p className="text-xs text-muted-foreground">
                {row.id} · sujet #{row.subjectUserId ?? 'non lié'} · {row.hasEmailHash ? 'empreinte e-mail présente' : 'sans empreinte'}
                {row.decisionCode ? ` · ${row.decisionCode}` : ''}
                {row.responseProof ? ` · preuve ${row.responseProof}` : ''}
              </p>
              <div className="flex flex-wrap gap-2 items-end">
                <div className="space-y-1">
                  <Label>E-mail déclaré (vérification)</Label>
                  <Input
                    value={claimedEmail[row.id] ?? ''}
                    onChange={(e) => setClaimedEmail((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  />
                </div>
                <Button variant="outline" size="sm" onClick={() => patch(row.id, { claimedEmail: claimedEmail[row.id], status: 'in_review' })}>
                  Lier l’identité
                </Button>
                <Button variant="outline" size="sm" onClick={() => patch(row.id, { applyRestriction: true })}>Appliquer restriction</Button>
                <Button variant="outline" size="sm" onClick={() => patch(row.id, { applyOpposition: true })}>Appliquer opposition</Button>
                <Button variant="outline" size="sm" onClick={() => patch(row.id, { issueExport: true })}>Émettre un export</Button>
                <Button variant="outline" size="sm" onClick={() => patch(row.id, { status: 'completed', decisionCode: 'delegated_erasure', responseProof: 'see-account-closure' })}>
                  Déléguer l’effacement (#11)
                </Button>
                <Button variant="outline" size="sm" onClick={() => patch(row.id, { status: 'completed', decisionCode: 'pending_human_legal_review', responseProof: 'legal-review' })}>
                  En revue juridique
                </Button>
              </div>
            </li>
          ))}
          {requests.length === 0 && <li className="text-sm text-muted-foreground">Aucune demande.</li>}
        </ul>
      </SectionCard>
    </div>
  );
}
