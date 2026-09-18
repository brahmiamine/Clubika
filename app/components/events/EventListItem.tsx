'use client';

import { logError, logInfo } from '@/lib/observability/client-log';
import { memo, useState, useCallback } from 'react';
import { Match, Entrainement, Plateau } from '@/types/match';
import { MatchListItem } from '../matches/MatchListItem';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar, Clock, MapPin, User, Trash2, ExternalLink, Trophy, Phone } from 'lucide-react';
import { apiDelete } from '@/lib/utils/api';
import { toast } from 'sonner';
import { TeamLogo } from '../ui/team-logo';
import { useClubs } from '@/hooks/useClubs';
import { useAppSettings } from '@/hooks/useAppSettings';
import { useMemo } from 'react';
import { useMatchExtras } from '@/hooks/useMatchExtras';
import { getVenueClasses, resolveMatchLogos } from '@/lib/utils/match';
import { cn } from '@/lib/utils';
import { planningEventTypeFromEvent } from '@/lib/planning/event-links';
import { EventCardWeather } from './EventCardWeather';

interface EventListItemProps {
  event: Match | Entrainement | Plateau;
  onEventUpdate?: () => void;
  readOnly?: boolean;
}

export const EventListItem = memo(function EventListItem({ event, onEventUpdate, readOnly = false }: EventListItemProps) {
  const { clubs } = useClubs();
  const { settings } = useAppSettings();
  const isMatch = 'localTeam' in event || 'competition' in event;
  const isMatchOfficiel = isMatch && (event as Match).type === 'officiel';
  const isMatchAmical = isMatch && (event as Match).type === 'amical';
  const isEntrainement = !isMatch && event.type === 'entrainement';
  const isPlateau = !isMatch && event.type === 'plateau';
  const match = isMatchAmical ? (event as Match) : null;
  const { extras } = useMatchExtras(match?.id);
  
  const { localTeamLogo, awayTeamLogo } = useMemo(() => {
    if (!match) return { localTeamLogo: undefined, awayTeamLogo: undefined };
    return resolveMatchLogos(match, clubs, {
      name: settings.clubName,
      logo: settings.clubLogo,
    });
  }, [match, clubs, settings.clubName, settings.clubLogo]);

  const venueClasses = match ? getVenueClasses(match.venue) : '';

  // Helper pour vérifier si un contact est un objet avec nom (rétrocompatibilité)
  const hasContactData = (contact: any): boolean => {
    if (Array.isArray(contact)) return contact.length > 0;
    if (contact && typeof contact === 'object' && 'nom' in contact) return !!contact.nom;
    return false;
  };

  // Helper pour obtenir un contact comme objet (rétrocompatibilité)
  const getContactAsObject = (contact: any): { nom: string; numero?: string } | null => {
    if (!contact) return null;
    if (Array.isArray(contact)) return null;
    if (contact && typeof contact === 'object' && 'nom' in contact) {
      return contact as { nom: string; numero?: string };
    }
    return null;
  };

  // La suppression reste disponible directement sur la ligne ; la modification se fait
  // depuis l'espace événement (clic sur la ligne).
  const canDelete = !readOnly && (isMatchAmical || isEntrainement || isPlateau);

  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    if (!window.confirm('Êtes-vous sûr de vouloir supprimer cet événement ?')) {
      return;
    }

    setIsDeleting(true);
    try {
      let endpoint = '';
      if (isMatchAmical) {
        endpoint = `/api/matches-amicaux?id=${encodeURIComponent(event.id || '')}`;
      } else if (isEntrainement) {
        endpoint = `/api/entrainements?id=${encodeURIComponent(event.id || '')}`;
      } else if (isPlateau) {
        endpoint = `/api/plateaux?id=${encodeURIComponent(event.id || '')}`;
      }

      if (endpoint && event.id) {
        const response = await apiDelete<{ success?: boolean; error?: string }>(endpoint);
        logInfo('app.unhandled', 'Delete response:', response);
        
        // Vérifier si la suppression a réussi (success: true ou pas d'erreur)
        if (response?.success === true || (!response?.error && response?.success !== false)) {
          toast.success('Événement supprimé avec succès');
          // Attendre un court instant puis forcer le rechargement
          // Utiliser await pour s'assurer que le rechargement se fait
          if (onEventUpdate) {
            // Attendre que la suppression soit bien écrite sur le disque
            await new Promise(resolve => setTimeout(resolve, 300));
            onEventUpdate();
          }
        } else {
          toast.error(response?.error || 'Erreur lors de la suppression de l\'événement');
        }
      }
    } catch (error) {
      logError('app.unhandled', 'Error deleting event:', error);
      toast.error('Erreur lors de la suppression de l\'événement');
    } finally {
      setIsDeleting(false);
    }
  }, [event, isMatchAmical, isEntrainement, isPlateau, onEventUpdate]);

  if (isMatchOfficiel) {
    return <MatchListItem match={event as Match} onMatchUpdate={onEventUpdate} />;
  }

  // Si c'est un match amical, utiliser le même format que MatchListItem
  if (isMatchAmical && match) {
    return (
      <div className="bg-card border border-border rounded-lg p-3 sm:p-4 hover:shadow-md transition-shadow">
          {/* En-tête avec date, heure, venue et compétition */}
          <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3 mb-3 sm:mb-4 pb-2 sm:pb-3 border-b">
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 sm:gap-2">
                <Calendar className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-muted-foreground shrink-0" />
                <span className="text-xs sm:text-sm font-semibold text-foreground">{match.date}</span>
              </div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-muted-foreground shrink-0" />
                <span className="text-xs sm:text-sm text-foreground">{match.time}</span>
              </div>
              <EventCardWeather eventType="amical" eventId={match.id} variant="inline" />
              <span className={cn('inline-block px-1.5 sm:px-2 py-0.5 sm:py-1 rounded text-xs font-semibold', venueClasses)}>
                {match.venue === 'domicile' ? '🏠' : '✈️'}
                <span className="hidden sm:inline ml-1">{match.venue === 'domicile' ? 'Domicile' : 'Extérieur'}</span>
              </span>
              {match.type && (
                <Badge variant="outline" className="text-xs capitalize">
                  {match.type}
                </Badge>
              )}
            </div>
            {canDelete && (
              <div className="flex items-center gap-1 sm:gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="h-7 w-7 sm:h-8 sm:w-8 text-destructive hover:text-destructive"
                  title="Supprimer le match"
                >
                  <Trash2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                </Button>
              </div>
            )}
          </div>

          {/* Équipes */}
          <div className="mb-3 sm:mb-4">
            <div className="flex items-center gap-2 sm:gap-3 mb-2">
              <div className="flex-1 flex items-center justify-end gap-2 min-w-0">
                <TeamLogo
                  logo={localTeamLogo}
                  name={match.localTeam}
                  size={32}
                  className="w-6 h-6 sm:w-8 sm:h-8 shrink-0"
                />
                <p className="font-semibold text-foreground text-sm sm:text-base break-words">{match.localTeam}</p>
              </div>
              <span className="text-muted-foreground font-bold text-sm sm:text-base shrink-0">VS</span>
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <p className="font-semibold text-foreground text-sm sm:text-base break-words">{match.awayTeam}</p>
                <TeamLogo
                  logo={awayTeamLogo}
                  name={match.awayTeam}
                  size={32}
                  className="w-6 h-6 sm:w-8 sm:h-8 shrink-0"
                />
              </div>
            </div>
            <div className="flex items-center justify-center gap-1.5 sm:gap-2 text-xs sm:text-sm text-muted-foreground">
              <Trophy className="w-3.5 h-3.5 sm:w-4 sm:h-4 shrink-0" />
              <span className="truncate">{match.competition}</span>
              {match.categorie && (
                <span className="ml-2 text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">
                  {match.categorie}
                </span>
              )}
            </div>
            {match.horaireRendezVous && (
              <p className="text-xs text-muted-foreground text-center mt-1">
                RDV: {match.horaireRendezVous}
              </p>
            )}
          </div>

          {/* Détails du stade */}
          {match.details?.stadium && (
            <div className="mb-3 sm:mb-4 pb-2 sm:pb-3 border-b">
              <div className="flex items-start gap-2">
                <MapPin className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs sm:text-sm font-medium text-foreground">{match.details.stadium}</p>
                  {match.details.address && (
                    <p className="text-xs text-muted-foreground mt-1 break-words">{match.details.address}</p>
                  )}
                  {match.details.terrainType && (
                    <p className="text-xs text-muted-foreground mt-1">Type: {match.details.terrainType}</p>
                  )}
                  {match.details.itineraryLink && (
                    <a
                      href={match.details.itineraryLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary/80 text-xs mt-1 inline-flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Voir l'itinéraire
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Staff du match */}
          {(match.staff?.referee || match.staff?.assistant1 || match.staff?.assistant2) && (
            <div className="mb-4 pb-3 border-b">
              <p className="text-xs font-semibold text-muted-foreground mb-2">Staff du match</p>
              <div className="text-xs text-foreground space-y-1">
                {match.staff.referee && (
                  <p>
                    Arbitre: <span className="font-medium">{match.staff.referee}</span>
                  </p>
                )}
                {match.staff.assistant1 && (
                  <p>
                    Assistant 1: <span className="font-medium">{match.staff.assistant1}</span>
                  </p>
                )}
                {match.staff.assistant2 && (
                  <p>
                    Assistant 2: <span className="font-medium">{match.staff.assistant2}</span>
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Informations supplémentaires (extras) */}
          {extras && (
            hasContactData(extras.arbitreTouche) ||
            hasContactData(extras.contactEncadrants) ||
            hasContactData(extras.contactAccompagnateur)
          ) && (
            <div className="bg-muted rounded-lg p-3">
              <p className="text-xs font-semibold text-foreground mb-2">Informations supplémentaires</p>
              <div className="text-xs text-foreground space-y-1.5">
                {/* Arbitres AFP */}
                {Array.isArray(extras.arbitreTouche) && extras.arbitreTouche.length > 0 && extras.arbitreTouche.map((arbitre, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <User className="w-3.5 h-3.5 text-primary shrink-0" />
                    <span>
                      Arb touche {extras.arbitreTouche!.length > 1 ? `#${index + 1}` : ''}: <span className="font-medium">{arbitre.nom}</span>
                      {arbitre.numero && (
                        <span className="text-muted-foreground"> - {arbitre.numero}</span>
                      )}
                    </span>
                  </div>
                ))}
                {(() => {
                  const oldArbitre = getContactAsObject(extras.arbitreTouche);
                  return oldArbitre && (
                  <div className="flex items-center gap-2">
                    <User className="w-3.5 h-3.5 text-primary shrink-0" />
                    <span>
                      Arb touche: <span className="font-medium">{oldArbitre.nom}</span>
                        {oldArbitre.numero && (
                          <span className="text-muted-foreground"> - {oldArbitre.numero}</span>
                        )}
                      </span>
                    </div>
                  );
                })()}
                
                {/* Encadrants */}
                {Array.isArray(extras.contactEncadrants) && extras.contactEncadrants.length > 0 && extras.contactEncadrants.map((encadrant, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <Phone className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <span>
                      Encadrant {extras.contactEncadrants!.length > 1 ? `#${index + 1}` : ''}: <span className="font-medium">{encadrant.nom}</span>
                      {encadrant.numero && (
                        <span className="text-muted-foreground"> - {encadrant.numero}</span>
                      )}
                    </span>
                  </div>
                ))}
                {(() => {
                  const oldEncadrant = getContactAsObject(extras.contactEncadrants);
                  return oldEncadrant && (
                    <div className="flex items-start gap-2">
                      <Phone className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                      <span>
                        Encadrants: <span className="font-medium">{oldEncadrant.nom}</span>
                        {oldEncadrant.numero && (
                          <span className="text-muted-foreground"> - {oldEncadrant.numero}</span>
                        )}
                      </span>
                    </div>
                  );
                })()}
                
                {/* Accompagnateurs */}
                {Array.isArray(extras.contactAccompagnateur) && extras.contactAccompagnateur.length > 0 && extras.contactAccompagnateur.map((accompagnateur, index) => (
                  <div key={index} className="flex items-start gap-2">
                    <Phone className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                    <span>
                      Accompagnateur {extras.contactAccompagnateur!.length > 1 ? `#${index + 1}` : ''}: <span className="font-medium">{accompagnateur.nom}</span>
                      {accompagnateur.numero && (
                        <span className="text-muted-foreground"> - {accompagnateur.numero}</span>
                      )}
                    </span>
                  </div>
                ))}
                {(() => {
                  const oldAccompagnateur = getContactAsObject(extras.contactAccompagnateur);
                  return oldAccompagnateur && (
                    <div className="flex items-start gap-2">
                      <Phone className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                      <span>
                        Accompagnateur: <span className="font-medium">{oldAccompagnateur.nom}</span>
                        {oldAccompagnateur.numero && (
                          <span className="text-muted-foreground"> - {oldAccompagnateur.numero}</span>
                        )}
                      </span>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
    );
  }

  // Pour les entraînements et plateaux, garder l'affichage actuel
  return (
      <div className="bg-card border border-border rounded-lg p-3 sm:p-4 hover:shadow-md transition-shadow relative">
        {canDelete && (
          <div className="absolute top-2 right-2 flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDelete}
              disabled={isDeleting}
              className="h-8 w-8 p-0 text-destructive hover:text-destructive"
              title="Supprimer"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4 pr-20">
          <div className="flex items-center gap-2 sm:gap-3">
            <Badge 
              variant={isEntrainement ? 'secondary' : 'outline'} 
              className="text-xs"
            >
              {isEntrainement ? 'Entraînement' : 'Plateau'}
            </Badge>
            <div className="flex items-center gap-2 text-sm sm:text-base">
              <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-muted-foreground" />
              <span className="font-medium">{event.time}</span>
            </div>
            <EventCardWeather
              eventType={planningEventTypeFromEvent(event)}
              eventId={event.id}
              variant="inline"
            />
          </div>

          {'lieu' in event && (
            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 text-xs sm:text-sm text-muted-foreground">
              {isEntrainement && (event as Entrainement).categorie && (
                <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">
                  {(event as Entrainement).categorie}
                </span>
              )}
              {isPlateau && (event as Plateau).categories && (event as Plateau).categories!.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {(event as Plateau).categories!.map((cat, idx) => (
                    <span key={idx} className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded">
                      {cat}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5 sm:gap-2">
                <MapPin className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span className="break-words">{event.lieu}</span>
              </div>
              {'encadrant' in event && event.encadrant && (
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <User className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  <span>
                    {event.encadrant?.prenom || ''} {event.encadrant?.nom || ''}
                  </span>
                </div>
              )}
              {'encadrants' in event && event.encadrants && event.encadrants.length > 0 && (
                <div className="flex flex-col gap-2 text-sm sm:text-base">
                  {event.encadrants.map((encadrant, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 sm:gap-2">
                      <User className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      <span>
                        {encadrant.nom}{encadrant.numero ? ` - ${encadrant.numero}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
  );
});
