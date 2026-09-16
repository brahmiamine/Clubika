'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import {
  DataCell,
  DataList,
  DataRow,
  PageContainer,
  PageHeader,
  SectionCard,
  StatusPill,
} from '@/app/components/layout/page-primitives';
import { toast } from 'sonner';
import { apiGet, apiPatch, apiPost, apiPut } from '@/lib/utils/api';
import {
  CONTACT_CATEGORIES,
  CONTACT_PROVENANCES,
  CONTACT_PROVENANCE_LABELS,
  CONTACT_PURPOSES,
  CONTACT_PURPOSE_LABELS,
  CONTACT_STATUSES,
  CONTACT_STATUS_LABELS,
  PRIVACY_NO_LEGAL_PROMISE,
  RIGHTS_TYPE_LABELS,
  type ContactCategory,
  type ContactProvenance,
  type ContactPurpose,
  type ContactStatus,
} from '@/lib/non-account-contacts/constants';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';

interface FicheMeta {
  category: string;
  provenance: string | null;
  purpose: string;
  collectedAt: string;
  notice: { version: string | null; channel: string; at: string | null; result: string };
  opposedAt: string | null;
  status: string;
}

interface Fiche {
  id: number;
  nom: string;
  telephone: string | null;
  telephoneMasked: boolean;
  planningFunctions: string[];
  meta: FicheMeta | null;
}

interface RightsRequest {
  id: string;
  type: keyof typeof RIGHTS_TYPE_LABELS;
  status: string;
  createdAt: string;
  processedAt: string | null;
  hasEmailHash: boolean;
  hasPhoneHash: boolean;
}

export default function FichesSansComptePage() {
  const [fiches, setFiches] = useState<Fiche[]>([]);
  const [noticeVersion, setNoticeVersion] = useState('');
  const [noticeText, setNoticeText] = useState('');
  const [requests, setRequests] = useState<RightsRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [csvText, setCsvText] = useState('');
  const [csvReport, setCsvReport] = useState<{ accepted: number; refused: Array<{ line: number; error: string }> } | null>(null);

  const [newNom, setNewNom] = useState('');
  const [newTelephone, setNewTelephone] = useState('');
  const [newCategory, setNewCategory] = useState<ContactCategory>('officiel');
  const [newProvenance, setNewProvenance] = useState<ContactProvenance>('responsable_club');
  const [newPurpose, setNewPurpose] = useState<ContactPurpose>('organisation_planning');

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [contacts, rights] = await Promise.all([
        apiGet<{ fiches: Fiche[]; notice: { version: string; text: string } }>('/api/non-account-contacts'),
        apiGet<{ requests: RightsRequest[] }>('/api/non-account-rights'),
      ]);
      setFiches(contacts.fiches);
      setNoticeVersion(contacts.notice.version);
      setNoticeText(contacts.notice.text);
      setRequests(rights.requests);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Chargement impossible');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveNotice = async () => {
    try {
      await apiPut('/api/non-account-contacts', { noticeVersion, noticeText });
      toast.success('Notice enregistrée');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Enregistrement impossible');
    }
  };

  const createFiche = async () => {
    const endpoints: Record<ContactCategory, string> = {
      officiel: '/api/officiels',
      encadrant: '/api/encadrants',
      accompagnateur: '/api/accompagnateurs',
    };
    try {
      await apiPost(endpoints[newCategory], {
        nom: newNom,
        telephone: newTelephone || undefined,
        provenance: newProvenance,
        purpose: newPurpose,
      });
      setNewNom('');
      setNewTelephone('');
      toast.success('Fiche créée');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Création impossible');
    }
  };

  const importCsv = async () => {
    try {
      const result = await apiPost<{ accepted: number; refused: Array<{ line: number; error: string }> }>(
        '/api/non-account-contacts/import',
        { csv: csvText },
      );
      setCsvReport({ accepted: result.accepted, refused: result.refused });
      toast.success(`${result.accepted} ligne(s) acceptée(s)`);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import impossible');
    }
  };

  const setStatus = async (id: number, status: ContactStatus) => {
    try {
      await apiPatch(`/api/non-account-contacts/${id}`, { status });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Mise à jour impossible');
    }
  };

  const markOpposition = async (id: number) => {
    try {
      await apiPatch(`/api/non-account-contacts/${id}`, { opposition: true });
      toast.success('Opposition enregistrée, téléphone retiré');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Opposition impossible');
    }
  };

  const processRequest = async (id: string, action: 'opposition' | 'erasure' | 'acknowledge' | 'rejected') => {
    try {
      if (action === 'rejected') {
        await apiPatch('/api/non-account-rights', { id, status: 'rejected' });
      } else {
        await apiPatch('/api/non-account-rights', { id, action });
      }
      toast.success('Demande traitée');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Traitement impossible');
    }
  };

  if (isLoading) {
    return <LoadingSpinner text="Chargement des fiches sans compte…" />;
  }

  return (
    <PageContainer>
      <PageHeader
        title="Fiches sans compte"
        description="Provenance, notice et droits pour les personnes enregistrées sans accès. La purge planifiée reste l’issue #9."
      />
      <p className="mb-4 text-xs text-muted-foreground">{PRIVACY_NO_LEGAL_PROMISE}</p>

      <SectionCard title="Notice d’information">
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="notice-version">Version (configurée par le club / DPO)</Label>
            <Input id="notice-version" value={noticeVersion} onChange={(e) => setNoticeVersion(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="notice-text">Texte</Label>
            <textarea
              id="notice-text"
              className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={noticeText}
              onChange={(e) => setNoticeText(e.target.value)}
            />
          </div>
          <Button type="button" onClick={() => void saveNotice()}>Enregistrer la notice</Button>
        </div>
      </SectionCard>

      <SectionCard title="Nouvelle fiche">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Nom</Label>
            <Input value={newNom} onChange={(e) => setNewNom(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Téléphone (optionnel, exige une provenance)</Label>
            <Input value={newTelephone} onChange={(e) => setNewTelephone(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Catégorie</Label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={newCategory} onChange={(e) => setNewCategory(e.target.value as ContactCategory)}>
              {CONTACT_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Provenance</Label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={newProvenance} onChange={(e) => setNewProvenance(e.target.value as ContactProvenance)}>
              {CONTACT_PROVENANCES.map((value) => <option key={value} value={value}>{CONTACT_PROVENANCE_LABELS[value]}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label>Finalité</Label>
            <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={newPurpose} onChange={(e) => setNewPurpose(e.target.value as ContactPurpose)}>
              {CONTACT_PURPOSES.map((value) => <option key={value} value={value}>{CONTACT_PURPOSE_LABELS[value]}</option>)}
            </select>
          </div>
        </div>
        <Button className="mt-3" type="button" disabled={!newNom.trim()} onClick={() => void createFiche()}>Créer</Button>
      </SectionCard>

      <SectionCard title="Fiches">
        <DataList>
          {fiches.map((fiche) => (
            <DataRow key={fiche.id} columns="minmax(0,1.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto">
              <DataCell>{fiche.nom}</DataCell>
              <DataCell className="text-muted-foreground">{fiche.telephone || '—'}{fiche.telephoneMasked ? ' (masqué)' : ''}</DataCell>
              <DataCell className="text-muted-foreground">{fiche.meta?.provenance ?? 'sans provenance'}</DataCell>
              <DataCell>
                <StatusPill tone={fiche.meta?.notice.result === 'sent' ? 'success' : 'warning'}>
                  notice {fiche.meta?.notice.result ?? 'pending'}
                </StatusPill>
              </DataCell>
              <DataCell className="flex flex-wrap gap-2">
                <select
                  className="h-9 rounded-md border border-input bg-background px-2 text-xs"
                  value={(fiche.meta?.status as ContactStatus) ?? 'active'}
                  onChange={(e) => void setStatus(fiche.id, e.target.value as ContactStatus)}
                >
                  {CONTACT_STATUSES.map((status) => (
                    <option key={status} value={status}>{CONTACT_STATUS_LABELS[status]}</option>
                  ))}
                </select>
                <Button type="button" size="sm" variant="outline" onClick={() => void markOpposition(fiche.id)}>Opposition</Button>
              </DataCell>
            </DataRow>
          ))}
        </DataList>
        {fiches.length === 0 ? <p className="text-sm text-muted-foreground">Aucune fiche sans compte.</p> : null}
      </SectionCard>

      <SectionCard title="Import CSV">
        <p className="mb-2 text-xs text-muted-foreground">
          Colonnes : nom, provenance, category, telephone (optionnel), purpose (optionnel). Le rapport ne recopie aucune valeur personnelle.
        </p>
        <textarea
          className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          placeholder={'nom,provenance,category,telephone\n'}
        />
        <Button className="mt-3" type="button" disabled={!csvText.trim()} onClick={() => void importCsv()}>Importer</Button>
        {csvReport ? (
          <p className="mt-2 text-sm">
            Acceptées : {csvReport.accepted}. Refusées : {csvReport.refused.map((row) => `ligne ${row.line} (${row.error})`).join(', ') || 'aucune'}.
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Demandes de droits">
        <DataList>
          {requests.map((request) => (
            <DataRow key={request.id} columns="minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) auto">
              <DataCell>{RIGHTS_TYPE_LABELS[request.type] ?? request.type}</DataCell>
              <DataCell>{request.status}</DataCell>
              <DataCell className="text-muted-foreground">
                {request.hasEmailHash ? 'email haché' : 'pas d’email'} · {request.hasPhoneHash ? 'téléphone haché' : 'pas de téléphone'}
              </DataCell>
              <DataCell className="flex flex-wrap gap-2">
                {request.status === 'received' ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void processRequest(request.id, 'acknowledge')}>Accusé</Button>
                    <Button size="sm" variant="outline" onClick={() => void processRequest(request.id, 'opposition')}>Opposition</Button>
                    <Button size="sm" variant="outline" onClick={() => void processRequest(request.id, 'erasure')}>Effacement</Button>
                    <Button size="sm" variant="ghost" onClick={() => void processRequest(request.id, 'rejected')}>Rejeter</Button>
                  </>
                ) : null}
              </DataCell>
            </DataRow>
          ))}
        </DataList>
        {requests.length === 0 ? <p className="text-sm text-muted-foreground">Aucune demande.</p> : null}
      </SectionCard>
    </PageContainer>
  );
}
