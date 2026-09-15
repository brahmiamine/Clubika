'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  ArrowLeft,
  CalendarDays,
  Clock3,
  CloudSun,
  Edit3,
  MapPin,
  Timer,
  Trash2,
  Users,
} from 'lucide-react';
import { Badge } from '@/app/components/ui/badge';
import { Button } from '@/app/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/utils/api';
import { toast } from 'sonner';
import { EventChatPanel } from '@/app/components/chat/EventChatPanel';
import { EventDetailsEditor } from '@/app/components/events/EventDetailsEditor';
import { EventAssignmentsEditor } from '@/app/components/events/EventAssignmentsEditor';
import { TeamMatchup } from '@/app/components/matches/TeamMatchup';
import { useAppSettings } from '@/app/hooks/useAppSettings';
import { loadEventWorkspaceModules } from '@/app/components/events/event-workspace-loader';
import { WeatherConditionIcon } from '@/app/components/events/WeatherConditionIcon';
import { getWeatherPresentation } from '@/lib/planning/weather-condition';
import { NO_SENSITIVE_PERSONAL_DATA_WARNING } from '@/lib/privacy/sensitive-copy';
import { roleLabelWithClub } from '@/lib/settings';
import type {
  PlanningEventSnapshot,
  PlanningEventType,
  PlanningRole,
} from '@/lib/planning/event-store';
import type { AssignmentContact, AttendanceStatus, Entrainement, Match, Plateau } from '@/types/match';

type PlanningStatus = 'draft' | 'published' | 'modified' | 'cancelled';

interface RecordItem<T> { id: string; payload: T; }
interface CommentPayload { text: string; authorName: string; createdAt: string; authorUserId: number; }
interface TaskPayload { label: string; description: string | null; dueAt: string | null; completedAt: string | null; assigneeUserId: number | null; }
interface ReportPayload { category: string; text: string; authorName: string; authorRole: string; createdAt: string; }
interface Attachment { id: string; fileName: string; mimeType: string; sizeBytes: number; createdAt: string; }
interface EventSnapshot extends PlanningEventSnapshot {
  myRoles?: PlanningRole[];
  canManage: boolean;
  localTeam?: string;
  awayTeam?: string;
  localTeamLogo?: string;
  awayTeamLogo?: string;
}
interface WeatherResult {
  available: boolean;
  provider: string;
  reason?: string;
  weatherCode?: number;
  isDay?: boolean | null;
  severity?: 'normal' | 'warning' | 'severe';
  temperatureC?: number | null;
  precipitationProbability?: number | null;
  windGustKmh?: number | null;
  alerts?: string[];
  locationSource?: string;
}

const eventTypeLabels: Record<PlanningEventType, string> = {
  officiel: 'Match officiel',
  amical: 'Match amical',
  entrainement: 'Entraînement',
  plateau: 'Plateau',
};

const roleLabels: Record<PlanningRole, string> = {
  arbitre: 'Arbitre club',
  encadrant: 'Encadrant',
  accompagnateur: 'Accompagnateur',
};

const attendanceLabels: Record<Exclude<AttendanceStatus, 'unknown'>, string> = {
  present: 'Présent',
  excused: 'Excusé',
  absent: 'Absent',
  replaced: 'Remplacé',
};

function contactKey(role: PlanningRole, contact: AssignmentContact, index: number): string {
  return `${role}:${contact.personId ?? `${contact.nom}:${index}`}`;
}

function planningStatusBadge(status: PlanningStatus) {
  if (status === 'draft') return <Badge variant="secondary">Brouillon</Badge>;
  if (status === 'modified') return <Badge variant="outline">Modifié</Badge>;
  if (status === 'cancelled') return <Badge variant="destructive">Annulé</Badge>;
  return <Badge>Publié</Badge>;
}

export interface EventWorkspaceViewProps {
  eventType: PlanningEventType;
  eventId: string;
  backHref: string;
  backLabel: string;
  personalScope?: boolean;
  readOnly?: boolean;
}

/**
 * Vue partagée de l'espace événement (détails, météo, affectations, collaboration,
 * documents, rapports, chat). Utilisée à la fois depuis /club et /mon-planning : les
 * API sous-jacentes déterminent ce que chaque compte peut voir ou modifier.
 * Le contexte de consultation du tableau de bord impose en plus un mode lecture seule :
 * aucune mutation de l'événement ou de ses données collaboratives n'est proposée.
 */
export function EventWorkspaceView({
  eventType,
  eventId,
  backHref,
  backLabel,
  personalScope = false,
  readOnly = false,
}: EventWorkspaceViewProps) {
  const router = useRouter();
  const { settings } = useAppSettings();
  const clubAbbr = settings.clubAbbreviation;
  const collaborationEnabled = settings.features.collaboration;
  const weatherEnabled = settings.features.travelAndWeather;
  const chatEnabled = settings.features.eventChat;
  const base = `/api/planning/events/${encodeURIComponent(eventType)}/${encodeURIComponent(eventId)}`;
  const withScope = useCallback((url: string) => {
    if (!personalScope) return url;
    return `${url}${url.includes('?') ? '&' : '?'}scope=personal`;
  }, [personalScope]);
  const [eventDetails, setEventDetails] = useState<EventSnapshot | null>(null);
  const [comments, setComments] = useState<Array<RecordItem<CommentPayload>>>([]);
  const [tasks, setTasks] = useState<Array<RecordItem<TaskPayload>>>([]);
  const [reports, setReports] = useState<Array<RecordItem<ReportPayload>>>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [weather, setWeather] = useState<WeatherResult | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canSubmitReport, setCanSubmitReport] = useState(false);
  const [comment, setComment] = useState('');
  const [task, setTask] = useState('');
  const [report, setReport] = useState('');
  const [reportCategory, setReportCategory] = useState('organisation');
  const [loading, setLoading] = useState(true);
  const [editingDetails, setEditingDetails] = useState(false);
  const [editingAssignments, setEditingAssignments] = useState(false);
  const [savingAttendanceKey, setSavingAttendanceKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const weatherQuery = new URLSearchParams({ eventType, eventId });
      if (personalScope) weatherQuery.set('scope', 'personal');
      const {
        snapshot,
        collaboration,
        reports: reportData,
        attachments: attachmentData,
        weather: weatherData,
      } = await loadEventWorkspaceModules<
        EventSnapshot,
        { comments: Array<RecordItem<CommentPayload>>; tasks: Array<RecordItem<TaskPayload>>; canManage: boolean },
        { reports: Array<RecordItem<ReportPayload>>; canSubmit: boolean },
        { attachments: Attachment[]; canManage: boolean },
        WeatherResult
      >({
        base,
        withScope,
        collaborationEnabled,
        weatherEnabled,
        weatherUrl: `/api/planning/weather?${weatherQuery.toString()}`,
        apiGet,
      });
      setEventDetails(snapshot);
      setComments(collaboration?.comments ?? []);
      setTasks(collaboration?.tasks ?? []);
      setReports(reportData?.reports ?? []);
      setAttachments(attachmentData?.attachments ?? []);
      setWeather(weatherData);
      setCanManage(!readOnly && (snapshot.canManage || !!collaboration?.canManage || !!attachmentData?.canManage));
      setCanSubmitReport(!readOnly && !!reportData?.canSubmit);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Accès à l’espace événement impossible');
    } finally {
      setLoading(false);
    }
  }, [base, collaborationEnabled, eventId, eventType, personalScope, readOnly, weatherEnabled, withScope]);

  useEffect(() => { void load(); }, [load]);

  const addComment = async () => {
    try {
      await apiPost(withScope(`${base}/collaboration`), { kind: 'comment', text: comment });
      setComment('');
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Commentaire impossible'); }
  };

  const addTask = async () => {
    try {
      await apiPost(withScope(`${base}/collaboration`), { kind: 'task', label: task });
      setTask('');
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Création de tâche impossible'); }
  };

  const addReport = async () => {
    try {
      await apiPost(withScope(`${base}/reports`), { category: reportCategory, text: report });
      setReport('');
      toast.success('Rapport envoyé');
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Rapport impossible'); }
  };

  const setAttendance = async (
    role: PlanningRole,
    contact: AssignmentContact,
    index: number,
    status: Exclude<AttendanceStatus, 'unknown'>,
  ) => {
    const key = contactKey(role, contact, index);
    setSavingAttendanceKey(key);
    try {
      await apiPost('/api/planning/attendance', {
        eventType,
        eventId,
        role,
        status,
        ...(contact.personId !== undefined ? { personId: contact.personId } : { personNom: contact.nom }),
      });
      toast.success('Présence enregistrée');
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Présence impossible à enregistrer');
    } finally {
      setSavingAttendanceKey(null);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    try {
      const response = await fetch(withScope(`${base}/attachments`), { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Upload impossible');
      toast.success('Document ajouté');
      await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Upload impossible'); }
  };

  // Suppression d'un événement créé dans l'app (amical, entraînement, plateau) : les matchs
  // officiels proviennent du site fédéral et ne se suppriment pas ici. On s'appuie sur la
  // permission réelle du snapshot (`canManage`), indépendante du mode lecture seule du
  // tableau de bord, puis on repart vers la page d'où l'on vient.
  const [deletingEvent, setDeletingEvent] = useState(false);
  const deletableEndpoint: string | null = eventType === 'amical'
    ? `/api/matches-amicaux?id=${encodeURIComponent(eventId)}`
    : eventType === 'entrainement'
      ? `/api/entrainements?id=${encodeURIComponent(eventId)}`
      : eventType === 'plateau'
        ? `/api/plateaux?id=${encodeURIComponent(eventId)}`
        : null;
  const canDeleteEvent = !personalScope && !!deletableEndpoint && !!eventDetails?.canManage;

  const deleteEvent = async () => {
    if (!deletableEndpoint) return;
    if (!window.confirm('Supprimer définitivement cet événement ? Cette action est irréversible.')) return;
    setDeletingEvent(true);
    try {
      await apiDelete(deletableEndpoint);
      toast.success('Événement supprimé');
      router.push(backHref);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Suppression impossible');
      setDeletingEvent(false);
    }
  };

  const weatherCondition = weather?.available && typeof weather.weatherCode === 'number'
    ? getWeatherPresentation(weather.weatherCode, weather.isDay)
    : null;

  const payload = eventDetails?.event;
  const isMatch = eventDetails?.eventType === 'officiel' || eventDetails?.eventType === 'amical';
  const matchPayload = isMatch && payload ? payload as Match : null;
  const trainingPayload = eventDetails?.eventType === 'entrainement' && payload ? payload as Entrainement : null;
  const plateauPayload = eventDetails?.eventType === 'plateau' && payload ? payload as Plateau : null;
  const simpleLocation = trainingPayload?.lieu ?? plateauPayload?.lieu ?? null;

  // Entraînements et plateaux : pas d'arbitre AFP ni d'accompagnateur, seulement des encadrants.
  const isSimpleEvent = eventDetails?.eventType === 'entrainement' || eventDetails?.eventType === 'plateau';

  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-3">
        <Button variant="ghost" size="sm" asChild className="-ml-2 gap-2">
          <Link href={backHref}><ArrowLeft className="h-4 w-4" /> {backLabel}</Link>
        </Button>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-medium text-primary">Espace événements</p>
            <h2 className="text-2xl font-bold sm:text-3xl">
              {eventDetails?.localTeam || eventDetails?.awayTeam ? (
                <TeamMatchup
                  localTeam={eventDetails.localTeam}
                  awayTeam={eventDetails.awayTeam}
                  localTeamLogo={eventDetails.localTeamLogo}
                  awayTeamLogo={eventDetails.awayTeamLogo}
                  separator="–"
                  logoSize={28}
                />
              ) : (
                eventDetails?.title ?? 'Détail de l’événement'
              )}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">Toutes les informations opérationnelles et collaboratives de l’événement.</p>
          </div>
          {eventDetails && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{eventTypeLabels[eventDetails.eventType]}</Badge>
              {personalScope && eventDetails.myRoles?.map((role) => (
                <Badge key={role} variant="outline">Ma fonction : {roleLabels[role]}</Badge>
              ))}
              {planningStatusBadge(eventDetails.planningStatus as PlanningStatus)}
              {canManage && (
                <Button size="sm" onClick={() => setEditingDetails(true)} className="gap-2">
                  <Edit3 className="h-4 w-4" /> Modifier l’événement
                </Button>
              )}
              {canDeleteEvent && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={deleteEvent}
                  disabled={deletingEvent}
                  className="gap-2"
                >
                  <Trash2 className="h-4 w-4" /> Supprimer
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {loading ? <LoadingSpinner text="Chargement de l’espace événement..." className="py-16" /> : eventDetails ? (
        <>
          {weatherEnabled && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-3 text-base">
                {weatherCondition ? (
                  <>
                    <WeatherConditionIcon kind={weatherCondition.icon} label={weatherCondition.label} className="h-8 w-8 shrink-0 text-sky-500" />
                    {weatherCondition.label}
                  </>
                ) : (
                  <>
                    <CloudSun className="h-5 w-5" />
                    Météo de l’événement
                  </>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {weather?.available ? <div className="flex flex-wrap items-center gap-3 text-sm">
                <Badge variant={weather.severity === 'severe' ? 'destructive' : 'outline'}>{weather.severity === 'severe' ? 'Alerte' : weather.severity === 'warning' ? 'Vigilance' : 'Conditions normales'}</Badge>
                {weather.temperatureC !== null && weather.temperatureC !== undefined && <span>{Math.round(weather.temperatureC)} °C</span>}
                {weather.precipitationProbability !== null && weather.precipitationProbability !== undefined && <span>Pluie {Math.round(weather.precipitationProbability)} %</span>}
                {weather.windGustKmh !== null && weather.windGustKmh !== undefined && <span>Rafales {Math.round(weather.windGustKmh)} km/h</span>}
                {weather.locationSource && <span className="text-muted-foreground">{weather.locationSource}</span>}
                {!!weather.alerts?.length && <span className="w-full text-amber-700 dark:text-amber-400">{weather.alerts.join(' · ')}</span>}
                <span className="w-full text-xs text-muted-foreground">Source : Open-Meteo · prévision indicative, sans impact automatique sur le planning.</span>
              </div> : <p className="text-sm text-muted-foreground">Prévision indisponible pour ce lieu ou cette échéance. Source configurée : Open-Meteo.</p>}
            </CardContent>
          </Card>
          )}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-3">
              <CardTitle className="text-base">Détails de l’événement</CardTitle>
              {canManage && <Button variant="outline" size="sm" onClick={() => setEditingDetails(true)}><Edit3 className="mr-2 h-4 w-4" /> Modifier</Button>}
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border p-3"><CalendarDays className="mb-2 h-4 w-4 text-muted-foreground" /><p className="text-xs text-muted-foreground">Date</p><p className="font-medium">{eventDetails.date}</p></div>
                <div className="rounded-lg border p-3"><Clock3 className="mb-2 h-4 w-4 text-muted-foreground" /><p className="text-xs text-muted-foreground">Heure</p><p className="font-medium">{eventDetails.time || 'Non renseignée'}</p></div>
                <div className="rounded-lg border p-3"><Timer className="mb-2 h-4 w-4 text-muted-foreground" /><p className="text-xs text-muted-foreground">Durée</p><p className="font-medium">{eventDetails.durationMinutes} min</p></div>
                <div className="rounded-lg border p-3"><MapPin className="mb-2 h-4 w-4 text-muted-foreground" /><p className="text-xs text-muted-foreground">Lieu</p><p className="font-medium">{eventDetails.location || simpleLocation || 'Non renseigné'}</p></div>
              </div>

              {matchPayload ? (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="rounded-lg border p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Rencontre</p>
                    <p className="mt-2 text-lg font-semibold">
                      <TeamMatchup
                        localTeam={eventDetails.localTeam ?? matchPayload.localTeam}
                        awayTeam={eventDetails.awayTeam ?? matchPayload.awayTeam}
                        localTeamLogo={eventDetails.localTeamLogo ?? matchPayload.localTeamLogo}
                        awayTeamLogo={eventDetails.awayTeamLogo ?? matchPayload.awayTeamLogo}
                        separator="–"
                        logoSize={24}
                      />
                    </p>
                    <div className="mt-3 space-y-1 text-sm text-muted-foreground">
                      {matchPayload.competition && <p>Compétition : <span className="text-foreground">{matchPayload.competition}</span></p>}
                      {matchPayload.categorie && <p>Catégorie : <span className="text-foreground">{matchPayload.categorie}</span></p>}
                      {matchPayload.venue && <p>Lieu de rencontre : <span className="text-foreground">{matchPayload.venue}</span></p>}
                      {matchPayload.horaireRendezVous && <p>Rendez-vous : <span className="text-foreground">{matchPayload.horaireRendezVous}</span></p>}
                    </div>
                  </div>
                  <div className="rounded-lg border p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stade & officiels</p>
                    <div className="mt-2 space-y-1 text-sm">
                      {matchPayload.details?.stadium && <p className="font-medium">{matchPayload.details.stadium}</p>}
                      {matchPayload.details?.address && <p className="text-muted-foreground">{matchPayload.details.address}</p>}
                      {matchPayload.details?.terrainType && <p className="text-muted-foreground">Terrain : {matchPayload.details.terrainType}</p>}
                      {matchPayload.staff?.referee && <p>Arbitre officiel : {matchPayload.staff.referee}</p>}
                      {matchPayload.staff?.assistant1 && <p>Assistant 1 : {matchPayload.staff.assistant1}</p>}
                      {matchPayload.staff?.assistant2 && <p>Assistant 2 : {matchPayload.staff.assistant2}</p>}
                      {matchPayload.details?.itineraryLink && <a className="inline-block pt-1 text-primary hover:underline" href={matchPayload.details.itineraryLink} target="_blank" rel="noreferrer">Ouvrir l’itinéraire</a>}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border p-4 text-sm">
                  {trainingPayload?.categorie && <p>Catégorie : <span className="font-medium">{trainingPayload.categorie}</span></p>}
                  {!!plateauPayload?.categories?.length && <p>Catégories : <span className="font-medium">{plateauPayload.categories.join(', ')}</span></p>}
                  {simpleLocation && <p>Lieu : <span className="font-medium">{simpleLocation}</span></p>}
                </div>
              )}

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2"><Users className="h-4 w-4" /><p className="text-sm font-semibold">Affectations</p></div>
                  {(isMatch || isSimpleEvent) && canManage && (
                    <Button
                      size="sm"
                      variant={editingAssignments ? 'outline' : 'default'}
                      onClick={() => setEditingAssignments((value) => !value)}
                    >
                      {editingAssignments ? 'Annuler' : <><Edit3 className="mr-2 h-4 w-4" /> Modifier les affectations</>}
                    </Button>
                  )}
                </div>

                {canManage && editingAssignments && (isMatch || isSimpleEvent) ? (
                  <EventAssignmentsEditor
                    matchPayload={matchPayload}
                    eventId={eventId}
                    isPlateau={eventDetails.eventType === 'plateau'}
                    initialEncadrants={(trainingPayload ?? plateauPayload)?.encadrants ?? []}
                    clubAbbr={clubAbbr}
                    onCancel={() => setEditingAssignments(false)}
                    onSaved={async () => { setEditingAssignments(false); await load(); }}
                  />
                ) : (
                  <div className="grid gap-3 md:grid-cols-3">
                    {(Object.keys(roleLabels) as PlanningRole[]).map((role) => (
                      <div key={role} className="rounded-lg border p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{roleLabelWithClub(roleLabels[role], clubAbbr)}</p>
                        {eventDetails.assignments[role].length ? eventDetails.assignments[role].map((contact, index) => {
                          const key = contactKey(role, contact, index);
                          const isSaving = savingAttendanceKey === key;
                          return (
                            <div key={key} className="mt-2 text-sm">
                              <p className="font-medium">{contact.nom}</p>
                              {contact.numero && <p className="text-xs text-muted-foreground">{contact.numero}</p>}
                              {contact.status && <p className="text-xs text-muted-foreground">Statut : {contact.status}</p>}
                              {canManage && settings.features.attendanceTracking && contact.status !== 'declined' && (
                                <div className="mt-2 space-y-1">
                                  <p className="text-xs text-muted-foreground">
                                    Présence : {contact.attendanceStatus && contact.attendanceStatus !== 'unknown' ? attendanceLabels[contact.attendanceStatus] : 'Non renseignée'}
                                  </p>
                                  <div className="flex flex-wrap gap-1">
                                    {(Object.keys(attendanceLabels) as Array<Exclude<AttendanceStatus, 'unknown'>>).map((status) => (
                                      <Button
                                        key={status}
                                        size="sm"
                                        variant={contact.attendanceStatus === status ? 'default' : 'outline'}
                                        disabled={isSaving}
                                        onClick={() => void setAttendance(role, contact, index, status)}
                                      >
                                        {attendanceLabels[status]}
                                      </Button>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        }) : <p className="mt-2 text-sm text-muted-foreground">Aucune affectation</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {collaborationEnabled && (
          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Commentaires</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {!readOnly && <div className="flex gap-2"><input className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Ajouter une information..." /><Button onClick={addComment} disabled={!comment.trim()}>Envoyer</Button></div>}
                {comments.length ? comments.map((item) => <div key={item.id} className="rounded-md border p-3"><p className="text-sm">{item.payload.text}</p><p className="mt-1 text-xs text-muted-foreground">{item.payload.authorName} · {new Date(item.payload.createdAt).toLocaleString('fr-FR')}</p></div>) : <p className="text-sm text-muted-foreground">Aucun commentaire.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Check-list / tâches</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {canManage && <div className="flex gap-2"><input className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" value={task} onChange={(event) => setTask(event.target.value)} placeholder="Ex. récupérer les clés" /><Button onClick={addTask} disabled={!task.trim()}>Ajouter</Button></div>}
                {tasks.length ? tasks.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-md border p-3"><div><p className={item.payload.completedAt ? 'text-sm line-through' : 'text-sm'}>{item.payload.label}</p>{item.payload.description && <p className="text-xs text-muted-foreground">{item.payload.description}</p>}</div>{canManage && <Button size="sm" variant={item.payload.completedAt ? 'outline' : 'default'} onClick={async () => { await apiPatch(withScope(`${base}/collaboration`), { id: item.id, completed: !item.payload.completedAt }); await load(); }}>{item.payload.completedAt ? 'Rouvrir' : 'Fait'}</Button>}</div>) : <p className="text-sm text-muted-foreground">Aucune tâche.</p>}
              </CardContent>
            </Card>
          </section>
          )}

          {collaborationEnabled && (
          <section className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Documents</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {canManage && <input type="file" className="block w-full text-sm" onChange={(event) => void upload(event.target.files?.[0])} accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx" />}
                {attachments.length ? attachments.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-md border p-3"><div><p className="text-sm font-medium">{item.fileName}</p><p className="text-xs text-muted-foreground">{Math.ceil(item.sizeBytes / 1024)} Ko</p></div><div className="flex gap-2"><Button size="sm" variant="outline" asChild><a href={withScope(`/api/planning/attachments/${item.id}`)}>Télécharger</a></Button>{canManage && <Button size="sm" variant="destructive" onClick={async () => { await apiDelete(withScope(`/api/planning/attachments/${item.id}`)); await load(); }}>Supprimer</Button>}</div></div>) : <p className="text-sm text-muted-foreground">Aucun document.</p>}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle className="text-base">Rapports post-événement</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {canSubmitReport && <div className="space-y-2"><select className="w-full rounded-md border bg-background px-3 py-2 text-sm" value={reportCategory} onChange={(event) => setReportCategory(event.target.value)}><option value="organisation">Organisation</option><option value="incident">Incident</option><option value="sportif">Sportif</option><option value="other">Autre</option></select><p className="text-xs text-muted-foreground">{NO_SENSITIVE_PERSONAL_DATA_WARNING}</p><textarea className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm" value={report} onChange={(event) => setReport(event.target.value)} placeholder="Compte rendu / incident / remarque..." /><Button onClick={addReport} disabled={!report.trim()}>Envoyer le rapport</Button></div>}
                {reports.length ? reports.map((item) => <div key={item.id} className="rounded-md border p-3"><div className="mb-1 flex items-center gap-2"><Badge variant="outline">{item.payload.category}</Badge><span className="text-xs text-muted-foreground">{item.payload.authorName}</span></div><p className="whitespace-pre-wrap text-sm">{item.payload.text}</p></div>) : <p className="text-sm text-muted-foreground">Aucun rapport.</p>}
              </CardContent>
            </Card>
          </section>
          )}

          {chatEnabled && !readOnly && <EventChatPanel eventType={eventType} eventId={eventId} />}
          <EventDetailsEditor snapshot={eventDetails} open={editingDetails} onOpenChange={setEditingDetails} onSaved={load} />
        </>
      ) : (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">Impossible de charger les détails de cet événement.</CardContent></Card>
      )}
    </div>
  );
}
