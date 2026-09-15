'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import { Header } from '@/app/components/layout/Header';
import { Button } from '@/app/components/ui/button';
import { PageHeader, SectionCard, StatusPill } from '@/app/components/layout/page-primitives';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiGet, apiPut } from '@/lib/utils/api';
import { formatIsoDate } from '@/lib/utils/date';
import type { OfficielIndisponibilite } from '@/lib/utils/officiel-availability';
import { INDISPO_REVIEW_LABELS, reviewStatusOf } from '@/lib/indisponibilites/review';
import { publicIndispoReviewLabel } from '@/lib/privacy/health-data';
import { toast } from 'sonner';

export default function MesIndisponibilitesPage() {
  const [items, setItems] = useState<OfficielIndisponibilite[]>([]);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<'day-range' | 'time-slot'>('day-range');
  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [date, setDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiGet<{ indisponibilites: OfficielIndisponibilite[] }>('/api/me/availability');
      setItems(data.indisponibilites);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de charger vos indisponibilités');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (next: OfficielIndisponibilite[]) => {
    const data = await apiPut<{ indisponibilites: OfficielIndisponibilite[] }>('/api/me/availability', { indisponibilites: next });
    setItems(data.indisponibilites);
  };

  const add = async () => {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}`;
    const item: OfficielIndisponibilite = type === 'day-range'
      ? { id, type, dateStart, dateEnd: dateEnd || dateStart }
      : { id, type, date, startTime, endTime };

    if (type === 'day-range' && !dateStart) {
      toast.error('Choisissez une date de début');
      return;
    }
    if (type === 'time-slot' && (!date || !startTime || !endTime)) {
      toast.error('Date, heure de début et heure de fin sont requises');
      return;
    }

    try {
      await save([...items, item]);
      setDateStart(''); setDateEnd(''); setDate(''); setStartTime(''); setEndTime('');
      toast.success('Indisponibilité ajoutée');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Enregistrement impossible');
    }
  };

  const remove = async (id: string) => {
    try {
      await save(items.filter((item) => item.id !== id));
      toast.success('Indisponibilité supprimée');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Suppression impossible');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      <Header onScrapeComplete={() => {}} />
      <main className="container mx-auto max-w-3xl px-3 py-6 sm:px-4 sm:py-8">
        <PageHeader
          className="mb-5"
          icon={<CalendarOff />}
          title="Mes indisponibilités"
          description="Ces créneaux sont pris en compte lors des affectations du planning."
        />

        {loading ? <LoadingSpinner size={40} text="Chargement..." className="py-16" /> : (
          <div className="space-y-5">
            <SectionCard
              title="Ajouter une indisponibilité"
              description="Bloquez une journée/période complète ou seulement un créneau horaire."
              contentClassName="space-y-4"
            >
                <div className="space-y-2">
                  <Label>Type</Label>
                  <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={type} onChange={(e) => setType(e.target.value as 'day-range' | 'time-slot')}>
                    <option value="day-range">Journée / période</option>
                    <option value="time-slot">Créneau horaire</option>
                  </select>
                </div>
                {type === 'day-range' ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-2"><Label>Date de début</Label><Input type="date" value={dateStart} onChange={(e) => setDateStart(e.target.value)} /></div>
                    <div className="space-y-2"><Label>Date de fin</Label><Input type="date" value={dateEnd} onChange={(e) => setDateEnd(e.target.value)} /></div>
                  </div>
                ) : (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-2"><Label>Date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
                    <div className="space-y-2"><Label>Début</Label><Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></div>
                    <div className="space-y-2"><Label>Fin</Label><Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div>
                  </div>
                )}
                <Button onClick={add}><Plus className="mr-2 h-4 w-4" /> Ajouter</Button>
            </SectionCard>

            <SectionCard title="Créneaux enregistrés" contentClassName="space-y-2">
                {!items.length ? <p className="py-6 text-center text-muted-foreground">Aucune indisponibilité.</p> : items.map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-secondary-soft">
                    <div>
                      <p className="font-medium">{item.type === 'day-range' ? 'Période indisponible' : 'Créneau indisponible'}</p>
                      <p className="text-sm text-muted-foreground">
                        {item.type === 'day-range'
                          ? `${formatIsoDate(item.dateStart)}${item.dateEnd && item.dateEnd !== item.dateStart ? ` → ${formatIsoDate(item.dateEnd)}` : ''}`
                          : `${formatIsoDate(item.date)} · ${item.startTime ?? ''} → ${item.endTime ?? ''}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <StatusPill tone={reviewStatusOf(item) === 'rejected' ? 'danger' : reviewStatusOf(item) === 'pending' ? 'pending' : 'success'}>
                          {INDISPO_REVIEW_LABELS[reviewStatusOf(item)]}
                        </StatusPill>
                        {publicIndispoReviewLabel(item) && reviewStatusOf(item) === 'rejected' && (
                          <p className="text-xs text-muted-foreground">Motif : {publicIndispoReviewLabel(item)}</p>
                        )}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon" aria-label="Supprimer" onClick={() => remove(item.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </div>
                ))}
            </SectionCard>
          </div>
        )}
      </main>
    </div>
  );
}
