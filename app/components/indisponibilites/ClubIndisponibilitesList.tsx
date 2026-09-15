'use client';

import { useMemo, useState } from 'react';
import { CalendarOff } from 'lucide-react';
import {
  DataCell,
  DataList,
  DataRow,
  PageContainer,
  PageHeader,
  SectionCard,
  StatusPill,
  type StatusTone,
} from '@/app/components/layout/page-primitives';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import {
  CLUB_INDISPO_FUNCTION_FILTERS,
  CLUB_INDISPO_REVIEW_FILTERS,
  CLUB_INDISPO_TEMPORAL_FILTERS,
  filterClubIndisponibilites,
  type ClubIndisponibiliteFilters,
  type ClubIndisponibiliteRow,
} from '@/lib/indisponibilites/club-listing';
import {
  INDISPO_REVIEW_CODE_LABELS,
  INDISPO_REVIEW_CODES,
  type IndispoReviewCode,
} from '@/lib/indisponibilites/review';
import type { IndispoReviewStatus, IndispoTemporalStatus } from '@/lib/utils/officiel-availability';
import type { PlanningFunction } from '@/lib/auth/roles';

const TEMPORAL_TONE: Record<IndispoTemporalStatus, StatusTone> = {
  current: 'warning',
  future: 'info',
  past: 'neutral',
};

const REVIEW_TONE: Record<IndispoReviewStatus, StatusTone> = {
  pending: 'pending',
  accepted: 'success',
  rejected: 'danger',
};

const COLUMNS = 'minmax(8rem,1.1fr) minmax(7rem,0.9fr) minmax(7rem,0.9fr) minmax(8rem,1.1fr) auto auto auto';

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

export function ClubIndisponibilitesList({
  items,
  onReview,
  reviewingId,
}: {
  items: ClubIndisponibiliteRow[];
  onReview?: (row: ClubIndisponibiliteRow, decision: 'accepted' | 'rejected', reviewCode?: IndispoReviewCode) => void;
  reviewingId?: string | null;
}) {
  const [query, setQuery] = useState('');
  const [planningFunction, setPlanningFunction] = useState<ClubIndisponibiliteFilters['planningFunction']>('all');
  const [temporalStatus, setTemporalStatus] = useState<ClubIndisponibiliteFilters['temporalStatus']>('all');
  const [reviewStatus, setReviewStatus] = useState<ClubIndisponibiliteFilters['reviewStatus']>('all');
  const [sort, setSort] = useState<ClubIndisponibiliteFilters['sort']>('chrono-asc');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectCode, setRejectCode] = useState<IndispoReviewCode>('schedule_too_broad');

  const visible = useMemo(
    () => filterClubIndisponibilites(items, { query, planningFunction, temporalStatus, reviewStatus, sort }),
    [items, query, planningFunction, temporalStatus, reviewStatus, sort],
  );

  return (
    <PageContainer>
      <PageHeader
        icon={<CalendarOff />}
        title="Indisponibilités"
        description="Les nouvelles demandes restent bloquantes pour le planning tant qu’elles ne sont pas refusées. Les campagnes de disponibilité restent sur une page séparée."
      />

      <SectionCard title="Recherche et filtres" contentClassName="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1.5">
          <Label htmlFor="indispo-search">Recherche par nom</Label>
          <Input
            id="indispo-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Nom du membre"
          />
        </div>
        <FilterSelect
          id="indispo-function"
          label="Fonction terrain"
          value={planningFunction ?? 'all'}
          onChange={(value) => setPlanningFunction(value as PlanningFunction | 'all')}
          options={CLUB_INDISPO_FUNCTION_FILTERS}
        />
        <FilterSelect
          id="indispo-temporal"
          label="Statut temporel"
          value={temporalStatus ?? 'all'}
          onChange={(value) => setTemporalStatus(value as IndispoTemporalStatus | 'all')}
          options={CLUB_INDISPO_TEMPORAL_FILTERS}
        />
        <FilterSelect
          id="indispo-review"
          label="Décision"
          value={reviewStatus ?? 'all'}
          onChange={(value) => setReviewStatus(value as IndispoReviewStatus | 'all')}
          options={CLUB_INDISPO_REVIEW_FILTERS}
        />
        <FilterSelect
          id="indispo-sort"
          label="Tri"
          value={sort ?? 'chrono-asc'}
          onChange={(value) => setSort(value as 'chrono-asc' | 'chrono-desc')}
          options={[
            { value: 'chrono-asc', label: 'Chronologique (croissant)' },
            { value: 'chrono-desc', label: 'Chronologique (décroissant)' },
          ]}
        />
      </SectionCard>

      <DataList
        columns={COLUMNS}
        header={(
          <>
            <span>Membre</span>
            <span>Fonctions</span>
            <span>Type</span>
            <span>Dates</span>
            <span>Période</span>
            <span>Décision</span>
            <span>Actions</span>
          </>
        )}
        isEmpty={visible.length === 0}
        empty={items.length === 0
          ? 'Aucune indisponibilité enregistrée pour ce club.'
          : 'Aucun résultat pour ces filtres.'}
      >
        {visible.map((row) => (
          <DataRow key={row.id} columns={COLUMNS}>
            <DataCell label="Membre">
              <p className="font-medium">{row.userName}</p>
            </DataCell>
            <DataCell label="Fonctions">
              {row.planningFunctionLabels.length > 0
                ? row.planningFunctionLabels.join(', ')
                : <span className="text-muted-foreground">Aucune</span>}
            </DataCell>
            <DataCell label="Type">{row.typeLabel}</DataCell>
            <DataCell label="Dates">
              <p>{row.label}</p>
              {row.type === 'time-slot' && row.startTime && row.endTime && (
                <p className="text-xs text-muted-foreground">{row.startTime} → {row.endTime}</p>
              )}
            </DataCell>
            <DataCell label="Période">
              <StatusPill tone={TEMPORAL_TONE[row.temporalStatus]}>{row.temporalLabel}</StatusPill>
            </DataCell>
            <DataCell label="Décision">
              <StatusPill tone={REVIEW_TONE[row.reviewStatus]}>{row.reviewLabel}</StatusPill>
              {row.reviewComment && (
                <p className="mt-1 text-xs text-muted-foreground">Motif : {row.reviewComment}</p>
              )}
            </DataCell>
            <DataCell label="Actions">
              {onReview && row.reviewStatus === 'pending' ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={reviewingId === row.id}
                      onClick={() => onReview(row, 'accepted')}
                    >
                      Accepter
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={reviewingId === row.id}
                      onClick={() => {
                        setRejectingId(row.id);
                        setRejectCode('schedule_too_broad');
                      }}
                    >
                      Refuser
                    </Button>
                  </div>
                  {rejectingId === row.id && (
                    <div className="space-y-2">
                      <Label htmlFor={`reject-${row.id}`}>Motif du refus</Label>
                      <select
                        id={`reject-${row.id}`}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={rejectCode}
                        onChange={(event) => setRejectCode(event.target.value as IndispoReviewCode)}
                      >
                        {INDISPO_REVIEW_CODES.map((code) => (
                          <option key={code} value={code}>{INDISPO_REVIEW_CODE_LABELS[code]}</option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={reviewingId === row.id}
                        onClick={() => {
                          onReview(row, 'rejected', rejectCode);
                          setRejectingId(null);
                        }}
                      >
                        Confirmer le refus
                      </Button>
                    </div>
                  )}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              )}
            </DataCell>
          </DataRow>
        ))}
      </DataList>
    </PageContainer>
  );
}
