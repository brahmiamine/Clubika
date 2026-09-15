"use client";

import { logError } from '@/lib/observability/client-log';
import { useRouter } from "next/navigation";
import { memo, useState, useCallback, useMemo } from "react";
import { Match, Entrainement, Plateau } from "@/types/match";
import { useMatchExtras, ContactOfficiel } from "@/hooks/useMatchExtras";
import { useOfficiels } from "@/hooks/useOfficiels";
import { useEncadrants } from "@/hooks/useEncadrants";
import { useAccompagnateurs } from "@/hooks/useAccompagnateurs";
import { useClubs } from "@/hooks/useClubs";
import { useAppSettings } from "@/hooks/useAppSettings";
import { roleLabelWithClub } from "@/lib/settings";
import { resolveMatchLogos } from "@/lib/utils/match";
import { OfficielCombobox } from "@/components/ui/officiel-combobox";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Bookmark, Copy, Trash2, X, Users, Send, Eye } from "lucide-react";
import { apiPut, apiPost, apiDelete } from "@/lib/utils/api";
import { creationEndpointFor, extractReusableEventFields, type DuplicableEventType } from "@/lib/planning/event-duplication";
import { SaveAsTemplateDialog } from "./SaveAsTemplateDialog";
import { toast } from "sonner";
import { formatDateWithDayName } from "@/lib/utils/date";
import { TeamLogo } from "@/components/ui/team-logo";
import { getOfficielAvailabilityStatus } from "@/lib/utils/officiel-availability";
import { checkPersonConflict, checkLocationConflict } from "@/lib/utils/assignment-conflicts";
import { MatchExtras } from "@/hooks/useMatchExtras";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { canEdit } from "@/lib/auth/roles";
import { eventWorkspaceHref, planningEventTypeFromEvent } from "@/lib/planning/event-links";
import { EventCardWeather } from "@/components/events/EventCardWeather";
import type { AlertItem } from "@/hooks/useDashboardData";
import type { PersonType, PlanningPublicationMeta } from "@/types/match";
import {
  filterActiveAssignments,
  hasDeclinedAssignment,
  resolveDisplayedPlanningStatus,
} from "@/lib/planning/declined-assignment";

type Event = Match | Entrainement | Plateau;

type DropZoneType = "arbitre" | "encadrant" | "accompagnateur";

interface EventCardDragProps {
  event: Event;
  allEvents?: Record<string, Event[]>;
  allExtras?: Record<string, MatchExtras>;
  onEventUpdate: () => void | Promise<void>;
  onDelete?: () => void;
  /** Signaux opérationnels de l'événement (postes manquants, refus, relances…). */
  alert?: AlertItem;
  /** Points bloquants de publication propres à cet événement. */
  publicationBlockers?: string[];
  onRemind?: () => void;
  actionBusy?: boolean;
}

const ROLE_LABELS: Record<DropZoneType, string> = {
  arbitre: "Arbitre",
  encadrant: "Encadrant",
  accompagnateur: "Accompagnateur",
};

const ROLE_PERSON_TYPE: Record<DropZoneType, PersonType> = {
  arbitre: "officiel",
  encadrant: "encadrant",
  accompagnateur: "accompagnateur",
};

function planningStatusBadge(status: AlertItem["planningStatus"]) {
  if (status === "draft") return <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">Brouillon</Badge>;
  if (status === "modified") return <Badge variant="outline" className="h-4 px-1.5 text-[10px]">Modifié</Badge>;
  if (status === "cancelled") return <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">Annulé</Badge>;
  return <Badge className="h-4 px-1.5 text-[10px]">Publié</Badge>;
}

export const EventCardDrag = memo(function EventCardDrag({ event, allEvents, allExtras, onEventUpdate, onDelete, alert, publicationBlockers, onRemind, actionBusy }: EventCardDragProps) {
  const isMatch = "localTeam" in event || "competition" in event;
  const isMatchAmical = isMatch && (event as Match).type === "amical";
  const isEntrainement = !isMatch && event.type === "entrainement";
  const isPlateau = !isMatch && event.type === "plateau";
  const isMatchOfficiel = isMatch && !isMatchAmical;

  const { extras: fetchedExtras, save: saveExtras } = useMatchExtras(isMatchAmical || isMatchOfficiel ? event.id : undefined);
  const extras = fetchedExtras ?? (event.id ? allExtras?.[event.id] : undefined);
  const { officiels } = useOfficiels();
  const { encadrants } = useEncadrants();
  const { accompagnateurs } = useAccompagnateurs();
  const { clubs } = useClubs();
  const { settings } = useAppSettings();
  const clubAbbr = settings.clubAbbreviation;
  const { user } = useCurrentUser();

  const matchLogos = useMemo(
    () =>
      isMatch
        ? resolveMatchLogos(event as Match, clubs, {
            name: settings.clubName,
            logo: settings.clubLogo,
          })
        : { localTeamLogo: undefined, awayTeamLogo: undefined },
    [event, isMatch, clubs, settings.clubName, settings.clubLogo],
  );
  const editable = canEdit(user?.accessRole);
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDuplicating, setIsDuplicating] = useState(false);
  const [isSavingAsTemplate, setIsSavingAsTemplate] = useState(false);
  const [accordionValue, setAccordionValue] = useState<string>("");

  const openEvent = useCallback(() => {
    if (!event.id) return;
    router.push(eventWorkspaceHref(planningEventTypeFromEvent(event), event.id));
  }, [event, router]);

  const declinedContacts = alert?.declinedContacts ?? [];

  // Officiels encore actifs sur le brouillon : un refus (statut ou alerte dashboard)
  // n'apparaît plus comme affectation.
  const affectedOfficiels = useMemo(() => {
    const raw = (() => {
      if (isMatchAmical || isMatchOfficiel) {
        return {
          arbitres: Array.isArray(extras?.arbitreTouche) ? extras.arbitreTouche : extras?.arbitreTouche ? [extras.arbitreTouche] : [],
          encadrants: Array.isArray(extras?.contactEncadrants) ? extras.contactEncadrants : extras?.contactEncadrants ? [extras.contactEncadrants] : [],
          accompagnateurs: Array.isArray(extras?.contactAccompagnateur)
            ? extras.contactAccompagnateur
            : extras?.contactAccompagnateur
              ? [extras.contactAccompagnateur]
              : [],
        };
      }
      if (isEntrainement) {
        return { encadrants: (event as Entrainement).encadrants || [], arbitres: [], accompagnateurs: [] };
      }
      if (isPlateau) {
        return { encadrants: (event as Plateau).encadrants || [], arbitres: [], accompagnateurs: [] };
      }
      return { encadrants: [] as ContactOfficiel[], arbitres: [] as ContactOfficiel[], accompagnateurs: [] as ContactOfficiel[] };
    })();
    return {
      arbitres: filterActiveAssignments(raw.arbitres, "arbitre", declinedContacts),
      encadrants: filterActiveAssignments(raw.encadrants, "encadrant", declinedContacts),
      accompagnateurs: filterActiveAssignments(raw.accompagnateurs, "accompagnateur", declinedContacts),
    };
  }, [event, extras, declinedContacts, isMatchAmical, isMatchOfficiel, isEntrainement, isPlateau]);

  // Postes manquants / à remplacer calculés sur l'état LIVE de la carte (pas sur le snapshot
  // publié du dashboard qui peut être en retard sur les affectations en cours de préparation).
  const liveRoleStatus = useMemo(() => {
    const has = (list?: ContactOfficiel[]) => (list?.length ?? 0) > 0;
    const vacatedByDecline = (role: DropZoneType, list?: ContactOfficiel[]) =>
      !has(list) && declinedContacts.some((contact) => contact.role === role);
    const feats = settings.features;
    const missing: DropZoneType[] = [];
    const replacement: DropZoneType[] = [];

    if (isMatchAmical || isMatchOfficiel) {
      const map: Array<[DropZoneType, ContactOfficiel[] | undefined, boolean]> = [
        ["arbitre", affectedOfficiels.arbitres, feats.requireArbitreForPublication],
        ["encadrant", affectedOfficiels.encadrants, feats.requireEncadrantForPublication],
        ["accompagnateur", affectedOfficiels.accompagnateurs, feats.requireAccompagnateurForPublication],
      ];
      for (const [role, list, required] of map) {
        if ((required || vacatedByDecline(role, list)) && !has(list)) missing.push(role);
      }
    } else if (isEntrainement || isPlateau) {
      if (
        (feats.requireEncadrantForPublication || vacatedByDecline("encadrant", affectedOfficiels.encadrants))
        && !has(affectedOfficiels.encadrants)
      ) {
        missing.push("encadrant");
      }
    }
    return { missing, replacement };
  }, [affectedOfficiels, declinedContacts, settings.features, isMatchAmical, isMatchOfficiel, isEntrainement, isPlateau]);

  const candidatesForRole = useCallback(
    (role: DropZoneType) => {
      if (role === "arbitre") return officiels;
      if (role === "encadrant") return encadrants;
      return accompagnateurs;
    },
    [officiels, encadrants, accompagnateurs],
  );

  const handleAddOfficiel = useCallback(
    async (role: DropZoneType, officielNom: string) => {
      if (!officielNom.trim()) return;

      const officiel = candidatesForRole(role).find((o) => o.nom.toLowerCase().trim() === officielNom.toLowerCase().trim());

      if (!officiel) {
        toast.error("Officiel non trouvé");
        return;
      }

      const contact: ContactOfficiel = {
        nom: officiel.nom,
        numero: officiel.telephone || "",
        personId: officiel.id,
        personType: ROLE_PERSON_TYPE[role],
      };

      if (hasDeclinedAssignment(contact, role, declinedContacts)) {
        toast.error(`Impossible d'affecter ${officiel.nom} : cet officiel a déjà refusé ce poste.`);
        return;
      }

      const availability = getOfficielAvailabilityStatus(officiel, event.date, event.time);
      if (availability.unavailable) {
        toast.error(availability.message || "Cet officiel est indisponible pour cet événement.");
        return;
      }

      const flatEvents = Object.values(allEvents || {})
        .flat()
        .filter((e) => e.id !== event.id);
      const personConflict = checkPersonConflict(officiel.nom, role, event, flatEvents, allExtras || {});
      if (personConflict.conflict) {
        toast.warning(personConflict.message);
      }
      const locationConflict = checkLocationConflict(event, flatEvents);
      if (locationConflict.conflict) {
        toast.warning(locationConflict.message);
      }

      try {
        if (isMatchAmical || isMatchOfficiel) {
          const currentExtras = extras || {
            id: event.id || "",
            arbitreTouche: [],
            contactEncadrants: [],
            contactAccompagnateur: [],
          };

          const updatedExtras = { ...currentExtras };

          if (role === "arbitre") {
            const existing = filterActiveAssignments(
              Array.isArray(updatedExtras.arbitreTouche)
                ? updatedExtras.arbitreTouche
                : updatedExtras.arbitreTouche
                  ? [updatedExtras.arbitreTouche]
                  : [],
              "arbitre",
              declinedContacts,
            );
            if (!existing.some((c) => c.nom.toLowerCase() === contact.nom.toLowerCase())) {
              updatedExtras.arbitreTouche = [...existing, contact];
            }
          } else if (role === "encadrant") {
            const existing = filterActiveAssignments(
              Array.isArray(updatedExtras.contactEncadrants)
                ? updatedExtras.contactEncadrants
                : updatedExtras.contactEncadrants
                  ? [updatedExtras.contactEncadrants]
                  : [],
              "encadrant",
              declinedContacts,
            );
            if (!existing.some((c) => c.nom.toLowerCase() === contact.nom.toLowerCase())) {
              updatedExtras.contactEncadrants = [...existing, contact];
            }
          } else if (role === "accompagnateur") {
            const existing = filterActiveAssignments(
              Array.isArray(updatedExtras.contactAccompagnateur)
                ? updatedExtras.contactAccompagnateur
                : updatedExtras.contactAccompagnateur
                  ? [updatedExtras.contactAccompagnateur]
                  : [],
              "accompagnateur",
              declinedContacts,
            );
            if (!existing.some((c) => c.nom.toLowerCase() === contact.nom.toLowerCase())) {
              updatedExtras.contactAccompagnateur = [...existing, contact];
            }
          }

          const saved = await saveExtras(updatedExtras);
          if (!saved) return;
        } else if (isEntrainement || isPlateau) {
          const currentEncadrants = filterActiveAssignments(
            (event as Entrainement | Plateau).encadrants || [],
            "encadrant",
            declinedContacts,
          );
          if (!currentEncadrants.some((c) => c.nom.toLowerCase() === contact.nom.toLowerCase())) {
            const updatedEvent = {
              ...event,
              encadrants: [...currentEncadrants, contact],
            };
            await apiPut(isEntrainement ? "/api/entrainements" : "/api/plateaux", updatedEvent);
          }
        }

        toast.success("Officiel affecté avec succès");
        await onEventUpdate();
      } catch (error) {
        logError('app.unhandled', "Error adding officiel:", error);
        toast.error("Erreur lors de l'affectation de l'officiel");
      }
    },
    [event, extras, candidatesForRole, declinedContacts, isMatchAmical, isMatchOfficiel, isEntrainement, isPlateau, saveExtras, onEventUpdate, allEvents, allExtras],
  );

  const handleRemoveOfficiel = useCallback(
    async (role: DropZoneType, officielNom: string) => {
      try {
        if (isMatchAmical || isMatchOfficiel) {
          const currentExtras = extras || {
            id: event.id || "",
            arbitreTouche: [],
            contactEncadrants: [],
            contactAccompagnateur: [],
          };

          const updatedExtras = { ...currentExtras };

          if (role === "arbitre") {
            const existing = Array.isArray(updatedExtras.arbitreTouche)
              ? updatedExtras.arbitreTouche
              : updatedExtras.arbitreTouche
                ? [updatedExtras.arbitreTouche]
                : [];
            updatedExtras.arbitreTouche = existing.filter((c) => c.nom.toLowerCase() !== officielNom.toLowerCase());
          } else if (role === "encadrant") {
            const existing = Array.isArray(updatedExtras.contactEncadrants)
              ? updatedExtras.contactEncadrants
              : updatedExtras.contactEncadrants
                ? [updatedExtras.contactEncadrants]
                : [];
            updatedExtras.contactEncadrants = existing.filter((c) => c.nom.toLowerCase() !== officielNom.toLowerCase());
          } else if (role === "accompagnateur") {
            const existing = Array.isArray(updatedExtras.contactAccompagnateur)
              ? updatedExtras.contactAccompagnateur
              : updatedExtras.contactAccompagnateur
                ? [updatedExtras.contactAccompagnateur]
                : [];
            updatedExtras.contactAccompagnateur = existing.filter((c) => c.nom.toLowerCase() !== officielNom.toLowerCase());
          }

          const saved = await saveExtras(updatedExtras);
          if (!saved) return;
        } else if (isEntrainement || isPlateau) {
          const currentEncadrants = (event as Entrainement | Plateau).encadrants || [];
          const updatedEncadrants = currentEncadrants.filter((c) => c.nom.toLowerCase() !== officielNom.toLowerCase());
          const updatedEvent = {
            ...event,
            encadrants: updatedEncadrants,
          };
          await apiPut(isEntrainement ? "/api/entrainements" : "/api/plateaux", updatedEvent);
        }

        toast.success("Officiel retiré avec succès");
        await onEventUpdate();
      } catch (error) {
        logError('app.unhandled', "Error removing officiel:", error);
        toast.error("Erreur lors du retrait de l'officiel");
      }
    },
    [event, extras, isMatchAmical, isMatchOfficiel, isEntrainement, isPlateau, saveExtras, onEventUpdate],
  );

  const handleDelete = useCallback(async () => {
    if (!onDelete) return;
    if (!window.confirm("Êtes-vous sûr de vouloir supprimer cet événement ?")) {
      return;
    }

    setIsDeleting(true);
    try {
      let endpoint = "";
      if (isMatchAmical) {
        endpoint = `/api/matches-amicaux?id=${encodeURIComponent(event.id || "")}`;
      } else if (isEntrainement) {
        endpoint = `/api/entrainements?id=${encodeURIComponent(event.id || "")}`;
      } else if (isPlateau) {
        endpoint = `/api/plateaux?id=${encodeURIComponent(event.id || "")}`;
      }

      if (endpoint && event.id) {
        const response = await apiDelete<{ success: boolean; error?: string }>(endpoint);
        if (response?.success !== false && !response?.error) {
          toast.success("Événement supprimé avec succès");
          await onDelete();
        } else {
          toast.error(response?.error || "Erreur lors de la suppression de l'événement");
        }
      }
    } catch (error) {
      logError('app.unhandled', "Error deleting event:", error);
      toast.error("Erreur lors de la suppression de l'événement");
    } finally {
      setIsDeleting(false);
    }
  }, [event, isMatchAmical, isEntrainement, isPlateau, onDelete]);

  const duplicableEventType: DuplicableEventType | null = isMatchAmical
    ? "amical"
    : isEntrainement
      ? "entrainement"
      : isPlateau
        ? "plateau"
        : null;

  const handleDuplicate = useCallback(async () => {
    if (!duplicableEventType) return;
    setIsDuplicating(true);
    try {
      const fields = extractReusableEventFields(duplicableEventType, event);
      await apiPost(creationEndpointFor(duplicableEventType), {
        ...fields,
        date: event.date,
        time: event.time,
      });
      toast.success("Événement dupliqué en brouillon");
      await onEventUpdate();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Erreur lors de la duplication de l'événement");
    } finally {
      setIsDuplicating(false);
    }
  }, [event, duplicableEventType, onEventUpdate]);

  const handleSaveAsTemplate = useCallback(async (name: string) => {
    if (!duplicableEventType) return;
    const fields = extractReusableEventFields(duplicableEventType, event);
    await apiPost("/api/planning/event-templates", { name, eventType: duplicableEventType, fields });
  }, [event, duplicableEventType]);

  const getEventTitle = () => {
    if (isMatch) {
      const match = event as Match;
      return `${match.localTeam} vs ${match.awayTeam}`;
    } else if (isEntrainement) {
      return "Entraînement";
    } else if (isPlateau) {
      return "Plateau";
    }
    return "Événement";
  };

  // Compter le total d'officiels affectés
  const totalOfficiels = useMemo(() => {
    if (isMatchAmical || isMatchOfficiel) {
      return (
        (affectedOfficiels.arbitres?.length || 0) + (affectedOfficiels.encadrants?.length || 0) + (affectedOfficiels.accompagnateurs?.length || 0)
      );
    }
    return affectedOfficiels.encadrants?.length || 0;
  }, [affectedOfficiels, isMatchAmical, isMatchOfficiel]);

  const RoleSlot = ({
    role,
    label,
    officiels: zoneOfficiels,
  }: {
    role: DropZoneType;
    label: string;
    officiels: ContactOfficiel[];
  }) => (
    <div className="space-y-1.5">
      <Label className="text-[11px] font-semibold">{label}</Label>
      <div className="min-h-12.5 rounded-md border bg-muted/30 p-1.5">
        {zoneOfficiels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {zoneOfficiels.map((contact, idx) => (
              <Badge key={idx} variant="secondary" className="flex items-center gap-0.5 text-[10px] px-1.5 py-0 h-5">
                <span className="truncate max-w-25">{contact.nom}</span>
                {editable && (
                  <Button variant="ghost" size="icon" className="h-6 w-6 min-h-6 min-w-6 p-0" onClick={() => handleRemoveOfficiel(role, contact.nom)} aria-label={`Retirer ${contact.nom}`}>
                    <X className="h-2.5 w-2.5" />
                  </Button>
                )}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="py-1.5 text-center text-[10px] text-muted-foreground">Aucun dirigeant affecté</p>
        )}
        {editable && (
          <div className="mt-1.5">
            <OfficielCombobox
              officiels={candidatesForRole(role).filter((item) => {
                const availability = getOfficielAvailabilityStatus(item, event.date, event.time);
                return !(availability.unavailable && availability.blockLevel === "day");
              })}
              value=""
              onValueChange={(value) => handleAddOfficiel(role, value)}
              placeholder={`Sélectionner un ${label.toLowerCase()}`}
              className="h-7 text-[11px]"
            />
          </div>
        )}
      </div>
    </div>
  );

  return (
    <Card className="min-w-0 overflow-hidden p-2">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="flex-1 min-w-0">
            <div className="mb-0.5 flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center">
              {isMatch ? (
                <>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <TeamLogo logo={matchLogos.localTeamLogo} name={(event as Match).localTeam} size={20} className="h-5 w-5 shrink-0" />
                    <span className="min-w-0 break-words text-sm font-semibold">{(event as Match).localTeam}</span>
                    <Badge variant="secondary" className="h-4 shrink-0 px-1 py-0 text-[9px]">
                      {(event as Match).venue === "domicile" ? "Domicile" : "Extérieur"}
                    </Badge>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground">VS</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 break-words text-sm font-semibold">{(event as Match).awayTeam}</span>
                    <TeamLogo logo={matchLogos.awayTeamLogo} name={(event as Match).awayTeam} size={20} className="h-5 w-5 shrink-0" />
                  </div>
                  {isMatchOfficiel && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                      Officiel
                    </Badge>
                  )}
                  {isMatchAmical && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
                      Amical
                    </Badge>
                  )}
                </>
              ) : (
                <>
                  <h3 className="font-semibold text-sm truncate">{getEventTitle()}</h3>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="truncate">
                {formatDateWithDayName(event.date)} à {event.time}
              </span>
              <EventCardWeather
                eventType={planningEventTypeFromEvent(event)}
                eventId={event.id}
                variant="inline"
                className="text-[11px]"
              />
              {totalOfficiels > 0 && (
                <span className="flex items-center gap-1 shrink-0">
                  <Users className="h-3 w-3" />
                  {totalOfficiels}
                </span>
              )}
            </div>
            {isMatch && (
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                <p className="min-w-0 truncate text-[11px] text-muted-foreground">{(event as Match).competition}</p>
                {(event as Match).categorie && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">{(event as Match).categorie}</span>
                )}
              </div>
            )}
            {!isMatch && (
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                {isEntrainement && (event as Entrainement).categorie && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">{(event as Entrainement).categorie}</span>
                )}
                {isPlateau && (event as Plateau).categories && (event as Plateau).categories!.length > 0 && (
                  <>
                    {(event as Plateau).categories!.map((cat, idx) => (
                      <span key={idx} className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                        {cat}
                      </span>
                    ))}
                  </>
                )}
                <p className="min-w-0 truncate text-[11px] text-muted-foreground">{(event as Entrainement | Plateau).lieu}</p>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Consultation de l'espace événement : uniquement via ce bouton (le clic sur la carte ne navigue plus). */}
            {event.id && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={openEvent} title="Voir l’événement" aria-label="Voir l’événement">
                <Eye className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* Duplication et modèle (uniquement pour les événements créés manuellement) */}
            {editable && (isMatchAmical || isEntrainement || isPlateau) && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleDuplicate} disabled={isDuplicating} title="Dupliquer" aria-label="Dupliquer">
                <Copy className="h-3.5 w-3.5" />
              </Button>
            )}
            {editable && (isMatchAmical || isEntrainement || isPlateau) && (
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setIsSavingAsTemplate(true)} title="Enregistrer comme modèle" aria-label="Enregistrer comme modèle">
                <Bookmark className="h-3.5 w-3.5" />
              </Button>
            )}
            {/* Bouton Delete (uniquement pour les événements créés manuellement) */}
            {editable && (isMatchAmical || isEntrainement || isPlateau) && (
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={handleDelete} disabled={isDeleting} title="Supprimer" aria-label="Supprimer l'événement">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {(() => {
          const missing = liveRoleStatus.missing;
          const replacement = liveRoleStatus.replacement;
          const pending = alert?.pending ?? 0;
          const declinedPeople = declinedContacts;
          const declined = declinedPeople.length > 0 ? declinedPeople.length : (alert?.declined ?? 0);
          const remindersDue = alert?.remindersDue ?? 0;
          const status = resolveDisplayedPlanningStatus(
            extras?.planningStatus,
            (event as PlanningPublicationMeta).planningStatus,
            alert?.planningStatus,
          );
          const show = missing.length > 0
            || replacement.length > 0
            || pending > 0
            || declined > 0
            || remindersDue > 0
            || (status && status !== "published");
          if (!show) return null;
          return (
            <div
              className="mb-1 flex flex-wrap items-center gap-1"
              onClick={(clickEvent) => clickEvent.stopPropagation()}
            >
              {status && planningStatusBadge(status)}
              {missing.map((role) => (
                <Badge key={`m-${role}`} variant="destructive" className="h-4 px-1.5 text-[10px]">Manque {ROLE_LABELS[role]}</Badge>
              ))}
              {replacement.map((role) => (
                <Badge key={`r-${role}`} variant="destructive" className="h-4 px-1.5 text-[10px]">Remplacer {ROLE_LABELS[role]}</Badge>
              ))}
              {!!pending && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{pending} en attente</Badge>}
              {declinedPeople.length > 0
                ? declinedPeople.map((person) => (
                  <Badge
                    key={`d-${person.role}-${person.personId ?? person.nom}`}
                    variant="destructive"
                    className="h-4 px-1.5 text-[10px]"
                  >
                    {person.nom} a refusé · {ROLE_LABELS[person.role]}
                  </Badge>
                ))
                : !!declined && (
                  <Badge variant="destructive" className="h-4 px-1.5 text-[10px]">{declined} refus</Badge>
                )}
              {!!remindersDue && <Badge variant="outline" className="h-4 px-1.5 text-[10px]">{remindersDue} relance(s)</Badge>}

              {editable && !!pending && status === "published" && onRemind && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-5 gap-1 px-1.5 text-[10px]"
                  disabled={actionBusy}
                  onClick={() => onRemind()}
                >
                  <Send className="h-2.5 w-2.5" /> Relancer
                </Button>
              )}
            </div>
          );
        })()}

        {!!publicationBlockers?.length && (
          <div className="mb-1 rounded-md border border-destructive/40 bg-destructive/5 p-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-destructive">
              Bloquant pour la publication
            </p>
            <ul className="mt-1 space-y-0.5">
              {publicationBlockers.map((message, index) => (
                <li key={index} className="text-[11px] leading-snug text-destructive">
                  {message}
                </li>
              ))}
            </ul>
          </div>
        )}

        <Accordion
          type="single"
          collapsible
          value={accordionValue}
          onValueChange={setAccordionValue}
          className="w-full"
        >
          <AccordionItem value="details" className="border-0">
            <AccordionTrigger className="py-1 text-[11px] hover:no-underline">
              <span className="text-muted-foreground">{accordionValue === "details" ? "Masquer" : "Afficher"} les détails et affectations</span>
            </AccordionTrigger>
            <AccordionContent className="pt-2">
              {(isMatchAmical || isMatchOfficiel) && (
                <div className="space-y-2">
                  <RoleSlot role="arbitre" label={roleLabelWithClub("Arbitres", clubAbbr)} officiels={affectedOfficiels.arbitres || []} />
                  <RoleSlot role="encadrant" label={roleLabelWithClub("Encadrants", clubAbbr)} officiels={affectedOfficiels.encadrants || []} />
                  <RoleSlot
                    role="accompagnateur"
                    label={roleLabelWithClub("Accompagnateurs", clubAbbr)}
                    officiels={affectedOfficiels.accompagnateurs || []}
                  />
                </div>
              )}

              {(isEntrainement || isPlateau) && (
                <div className="space-y-2">
                  <RoleSlot role="encadrant" label={roleLabelWithClub("Encadrants", clubAbbr)} officiels={affectedOfficiels.encadrants || []} />
                </div>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      {duplicableEventType && (
        <SaveAsTemplateDialog
          open={isSavingAsTemplate}
          onOpenChange={setIsSavingAsTemplate}
          onSave={handleSaveAsTemplate}
        />
      )}
    </Card>
  );
});
