'use client';

import { useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { Label } from './label';
import { toast } from 'sonner';
import {
  DEFAULT_EXPORT_COLUMN_IDS,
  EXPORT_COLUMNS,
  exportFileName,
  type ExportColumnId,
} from '@/lib/planning/export';
import { createPlanningExport, downloadPlanningExport, triggerBlobDownload } from '@/lib/utils/planning-export-data';
import { useAppSettings } from '@/hooks/useAppSettings';
import { roleLabelWithClub } from '@/lib/settings';
import {
  EXPORT_MODAL_BODY_CLASS,
  EXPORT_MODAL_CONTENT_CLASS,
  EXPORT_MODAL_FIELDS_CLASS,
  EXPORT_MODAL_GRID_CLASS,
  EXPORT_MODAL_OPTION_CLASS,
} from './export-modal-layout';

interface ExportCsvModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type MatchType = 'officiel' | 'amical' | 'entrainement' | 'plateau';

const ROLE_LABEL_BASES: Partial<Record<ExportColumnId, string>> = {
  arbitreTouche: 'Arbitre',
  encadrants: 'Encadrants',
  contactAccompagnateur: 'Accompagnateur',
};

export function ExportCsvModal({ open, onOpenChange }: ExportCsvModalProps) {
  const { settings } = useAppSettings();
  const [selectedTypes, setSelectedTypes] = useState<Record<MatchType, boolean>>({
    officiel: true,
    amical: true,
    entrainement: true,
    plateau: true,
  });
  const [selectedOperational, setSelectedOperational] = useState<ExportColumnId[]>([...DEFAULT_EXPORT_COLUMN_IDS]);
  const [selectedIdentities, setSelectedIdentities] = useState<ExportColumnId[]>([]);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [includeIdentities, setIncludeIdentities] = useState(false);
  const [includePhones, setIncludePhones] = useState(false);
  const [purpose, setPurpose] = useState('');
  const [busy, setBusy] = useState(false);

  const operational = useMemo(() => EXPORT_COLUMNS.filter((column) => column.kind === 'operational'), []);
  const identities = useMemo(() => EXPORT_COLUMNS.filter((column) => column.kind === 'identity'), []);

  const labelFor = (id: ExportColumnId, fallback: string) => {
    const base = ROLE_LABEL_BASES[id];
    return base ? roleLabelWithClub(base, settings.clubAbbreviation) : fallback;
  };

  const toggle = (id: ExportColumnId, identity: boolean) => {
    const setter = identity ? setSelectedIdentities : setSelectedOperational;
    setter((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  };

  const handleExport = async () => {
    const eventTypes = (Object.keys(selectedTypes) as MatchType[]).filter((type) => selectedTypes[type]);
    const columns = includeIdentities ? [...selectedOperational, ...selectedIdentities] : selectedOperational;
    try {
      setBusy(true);
      const ticket = await createPlanningExport({
        format: 'csv',
        columns,
        eventTypes,
        includeDrafts,
        includeIdentities,
        includePhones: includeIdentities && includePhones,
        purpose: includeIdentities ? purpose : undefined,
      });
      const response = await downloadPlanningExport(ticket.token);
      triggerBlobDownload(await response.blob(), exportFileName('csv'));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Export CSV impossible');
    } finally {
      setBusy(false);
    }
  };

  const hasSelectedTypes = Object.values(selectedTypes).some(Boolean);
  const hasSelectedFields = selectedOperational.length > 0 || (includeIdentities && selectedIdentities.length > 0);
  const identityReady = !includeIdentities || purpose.trim().length >= 8;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={EXPORT_MODAL_CONTENT_CLASS}>
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>Export CSV</DialogTitle>
          <DialogDescription>
            Export opérationnel minimal. Les identités et téléphones restent désactivés tant que vous ne les demandez pas explicitement.
          </DialogDescription>
        </DialogHeader>

        <div className={EXPORT_MODAL_BODY_CLASS}>
          <div className="space-y-3">
            <Label className="text-base font-semibold">Types de matches</Label>
            <div className={EXPORT_MODAL_GRID_CLASS}>
              {(['officiel', 'amical', 'entrainement', 'plateau'] as MatchType[]).map((type) => (
                <div key={type} className={EXPORT_MODAL_OPTION_CLASS}>
                  <Checkbox
                    id={`csv-type-${type}`}
                    checked={selectedTypes[type]}
                    onCheckedChange={() => setSelectedTypes((prev) => ({ ...prev, [type]: !prev[type] }))}
                  />
                  <Label htmlFor={`csv-type-${type}`} className="text-sm font-normal cursor-pointer capitalize">
                    {type === 'officiel'
                      ? 'Matchs officiels'
                      : type === 'amical'
                        ? 'Matchs amicaux'
                        : type === 'entrainement'
                          ? 'Entraînements'
                          : 'Plateaux'}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <div className={EXPORT_MODAL_OPTION_CLASS}>
            <Checkbox id="csv-include-drafts" checked={includeDrafts} onCheckedChange={() => setIncludeDrafts((prev) => !prev)} />
            <Label htmlFor="csv-include-drafts" className="text-sm font-normal cursor-pointer">
              Inclure les modifications non publiées (brouillon de travail)
            </Label>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label className="text-base font-semibold">Champs opérationnels</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedOperational(operational.map((column) => column.id))}
                >
                  Tout sélectionner
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedOperational([])}>
                  Tout désélectionner
                </Button>
              </div>
            </div>
            <div className={EXPORT_MODAL_FIELDS_CLASS}>
              {operational.map((column) => (
                <div key={column.id} className={EXPORT_MODAL_OPTION_CLASS}>
                  <Checkbox
                    id={`csv-field-${column.id}`}
                    checked={selectedOperational.includes(column.id)}
                    onCheckedChange={() => toggle(column.id, false)}
                  />
                  <Label htmlFor={`csv-field-${column.id}`} className="text-sm font-normal cursor-pointer">
                    {labelFor(column.id, column.label)}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className={EXPORT_MODAL_OPTION_CLASS}>
              <Checkbox
                id="csv-include-identities"
                checked={includeIdentities}
                onCheckedChange={(checked) => {
                  setIncludeIdentities(Boolean(checked));
                  if (!checked) {
                    setIncludePhones(false);
                    setSelectedIdentities([]);
                  }
                }}
              />
              <Label htmlFor="csv-include-identities" className="text-sm font-normal cursor-pointer">
                Inclure des identités pour une finalité déclarée
              </Label>
            </div>
            {includeIdentities ? (
              <>
                <Label htmlFor="csv-purpose" className="text-sm">Finalité (obligatoire)</Label>
                <textarea
                  id="csv-purpose"
                  className="w-full min-h-16 rounded-md border bg-background px-3 py-2 text-sm"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder="Ex. convocation du week-end pour les encadrants"
                />
                <div className={EXPORT_MODAL_OPTION_CLASS}>
                  <Checkbox
                    id="csv-include-phones"
                    checked={includePhones}
                    onCheckedChange={(checked) => setIncludePhones(Boolean(checked))}
                  />
                  <Label htmlFor="csv-include-phones" className="text-sm font-normal cursor-pointer">
                    Inclure les numéros de téléphone
                  </Label>
                </div>
                <div className={EXPORT_MODAL_FIELDS_CLASS}>
                  {identities.map((column) => (
                    <div key={column.id} className={EXPORT_MODAL_OPTION_CLASS}>
                      <Checkbox
                        id={`csv-id-${column.id}`}
                        checked={selectedIdentities.includes(column.id)}
                        onCheckedChange={() => toggle(column.id, true)}
                      />
                      <Label htmlFor={`csv-id-${column.id}`} className="text-sm font-normal cursor-pointer">
                        {labelFor(column.id, column.label)}
                      </Label>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => void handleExport()} disabled={!hasSelectedTypes || !hasSelectedFields || !identityReady || busy}>
            Exporter CSV
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
