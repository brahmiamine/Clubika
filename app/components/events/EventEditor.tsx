'use client';

import { logError } from '@/lib/observability/client-log';
import { useState, useEffect, memo, useCallback } from 'react';
import { Match, Entrainement, Plateau } from '@/types/match';
import { useMatchExtras, MatchExtras, ContactOfficiel } from '@/hooks/useMatchExtras';
import { useOfficiels } from '@/hooks/useOfficiels';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ContactListEditor } from '@/components/ui/contact-list-editor';
import { StadeCombobox } from '@/components/ui/stade-combobox';
import { ClubCombobox } from '@/components/ui/club-combobox';
import { useStades, Stade } from '@/hooks/useStades';
import { useClubs, Club } from '@/hooks/useClubs';
import { useCategories } from '@/hooks/useCategories';
import { apiPut, apiDelete } from '@/lib/utils/api';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { MatchAuditLogPanel } from '@/components/events/MatchAuditLogPanel';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { canEdit } from '@/lib/auth/roles';
import { useAppSettings } from '@/hooks/useAppSettings';
import { roleLabelWithClub } from '@/lib/settings';

interface EventEditorProps {
  event: Match | Entrainement | Plateau;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
}

export const EventEditor = memo(function EventEditor({ 
  event, 
  onClose, 
  onSave,
  onDelete 
}: EventEditorProps) {
  const { settings } = useAppSettings();
  const clubAbbr = settings.clubAbbreviation;
  const isMatch = 'localTeam' in event || 'competition' in event;
  const isMatchAmical = isMatch && (event as Match).type === 'amical';
  const isEntrainement = !isMatch && event.type === 'entrainement';
  const isPlateau = !isMatch && event.type === 'plateau';

  // Pour les matchs amicaux, utiliser les extras
  const { extras, save: saveExtras } = useMatchExtras(isMatchAmical ? event.id : undefined);
  const { officiels, reload: reloadOfficiels } = useOfficiels();
  const { user } = useCurrentUser();
  const editable = canEdit(user?.accessRole);
  const { stades } = useStades();
  const { clubs } = useClubs();
  const { categories } = useCategories();

  // État pour les matchs amicaux (avec extras)
  const [matchExtras, setMatchExtras] = useState<MatchExtras>({
    id: event.id || '',
    confirmed: false,
    arbitreTouche: [],
    contactEncadrants: [],
    contactAccompagnateur: [],
  });

  // État pour les matchs amicaux (champs de base)
  const [matchData, setMatchData] = useState({
    date: (event as Match).date || '',
    time: (event as Match).time || '',
    localTeam: (event as Match).localTeam || '',
    awayTeam: (event as Match).awayTeam || '',
    competition: (event as Match).competition || '',
    categorie: (event as Match).categorie || '',
    venue: ((event as Match).venue || 'domicile') as 'domicile' | 'extérieur',
    horaireRendezVous: (event as Match).horaireRendezVous || '',
    stadium: (event as Match).details?.stadium || '',
    address: (event as Match).details?.address || '',
  });

  // État pour sélection de stade (match amical)
  const [selectedStade, setSelectedStade] = useState<Stade | null>(null);

  // État pour sélection de clubs (match amical)
  const [selectedLocalClub, setSelectedLocalClub] = useState<Club | null>(() => {
    if (!isMatchAmical) return null;
    const match = event as Match;
    const localTeamName = match.localTeam || '';
    if (localTeamName && clubs.length > 0) {
      return clubs.find(c => c.nom === localTeamName) || null;
    }
    return null;
  });

  const [selectedAwayClub, setSelectedAwayClub] = useState<Club | null>(() => {
    if (!isMatchAmical) return null;
    const match = event as Match;
    const awayTeamName = match.awayTeam || '';
    if (awayTeamName && clubs.length > 0) {
      return clubs.find(c => c.nom === awayTeamName) || null;
    }
    return null;
  });

  // État pour entraînement/plateau
  const [simpleEventData, setSimpleEventData] = useState({
    date: event.date || '',
    time: event.time || '',
    lieu: ('lieu' in event ? event.lieu : '') || '',
    categorie: isEntrainement ? (event as Entrainement).categorie || '' : '',
  });

  // État pour les catégories de plateau (plusieurs possibles)
  const [plateauCategories, setPlateauCategories] = useState<string[]>(() => {
    if (isPlateau) {
      return (event as Plateau).categories || [];
    }
    return [];
  });
  
  // État pour les encadrants (entraînements et plateaux)
  const [encadrantsEntrainement, setEncadrantsEntrainement] = useState<ContactOfficiel[]>(() => {
    if (isEntrainement) {
      const entrainement = event as Entrainement;
      // Si encadrants existe (nouveau format), l'utiliser
      if (entrainement.encadrants && entrainement.encadrants.length > 0) {
        return entrainement.encadrants;
      }
      // Sinon, convertir encadrant (ancien format) en encadrants
      if (entrainement.encadrant) {
        return [{ nom: entrainement.encadrant.nom, numero: '' }];
      }
    }
    return [];
  });
  
  const [encadrantsPlateau, setEncadrantsPlateau] = useState<ContactOfficiel[]>(() => {
    if (isPlateau) {
      const plateau = event as Plateau;
      // Si encadrants existe (nouveau format), l'utiliser
      if (plateau.encadrants && plateau.encadrants.length > 0) {
        return plateau.encadrants;
      }
      // Sinon, convertir encadrant (ancien format) en encadrants
      if (plateau.encadrant) {
        return [{ nom: plateau.encadrant.nom, numero: '' }];
      }
    }
    return [];
  });

  // État pour sélection de stade (entraînement)
  const [selectedStadeEntrainement, setSelectedStadeEntrainement] = useState<Stade | null>(null);

  const [isDeleting, setIsDeleting] = useState(false);

  // Quand un stade est sélectionné pour match amical, remplir les champs
  useEffect(() => {
    if (selectedStade) {
      setMatchData(prev => ({
        ...prev,
        stadium: selectedStade.nom,
        address: selectedStade.adresse || prev.address,
      }));
    }
  }, [selectedStade]);

  // Quand un stade est sélectionné pour entraînement, remplir le champ lieu
  useEffect(() => {
    if (selectedStadeEntrainement) {
      const lieuText = selectedStadeEntrainement.adresse 
        ? `${selectedStadeEntrainement.nom} - ${selectedStadeEntrainement.adresse}`
        : selectedStadeEntrainement.nom;
      setSimpleEventData(prev => ({
        ...prev,
        lieu: lieuText,
      }));
    }
  }, [selectedStadeEntrainement]);

  // Initialiser le stade sélectionné pour match amical quand les stades sont chargés
  useEffect(() => {
    if (isMatchAmical && stades.length > 0 && !selectedStade) {
      const match = event as Match;
      const stadiumName = match.details?.stadium || '';
      if (stadiumName) {
        const found = stades.find(s => s.nom === stadiumName);
        if (found) {
          setSelectedStade(found);
        }
      }
    }
  }, [isMatchAmical, stades, event, selectedStade]);

  // Initialiser les clubs sélectionnés quand les clubs sont chargés
  useEffect(() => {
    if (isMatchAmical && clubs.length > 0) {
      const match = event as Match;
      if (!selectedLocalClub && match.localTeam) {
        const found = clubs.find(c => c.nom === match.localTeam);
        if (found) {
          setSelectedLocalClub(found);
        }
      }
      if (!selectedAwayClub && match.awayTeam) {
        const found = clubs.find(c => c.nom === match.awayTeam);
        if (found) {
          setSelectedAwayClub(found);
        }
      }
    }
  }, [isMatchAmical, clubs, event, selectedLocalClub, selectedAwayClub]);

  // Initialiser le stade sélectionné pour entraînement quand les stades sont chargés
  useEffect(() => {
    if ((isEntrainement || isPlateau) && stades.length > 0 && !selectedStadeEntrainement) {
      const lieuValue = 'lieu' in event ? event.lieu : '';
      if (lieuValue) {
        const found = stades.find(s => lieuValue.includes(s.nom));
        if (found) {
          setSelectedStadeEntrainement(found);
        }
      }
    }
  }, [isEntrainement, isPlateau, stades, event, selectedStadeEntrainement]);

  // Charger les extras pour les matchs amicaux
  useEffect(() => {
    if (isMatchAmical && extras) {
      setMatchExtras({
        id: event.id || '',
        confirmed: extras.confirmed || false,
        arbitreTouche: Array.isArray(extras.arbitreTouche) ? extras.arbitreTouche : extras.arbitreTouche ? [extras.arbitreTouche] : [],
        contactEncadrants: Array.isArray(extras.contactEncadrants) ? extras.contactEncadrants : extras.contactEncadrants ? [extras.contactEncadrants] : [],
        contactAccompagnateur: Array.isArray(extras.contactAccompagnateur) ? extras.contactAccompagnateur : extras.contactAccompagnateur ? [extras.contactAccompagnateur] : [],
      });
    }
  }, [extras, isMatchAmical, event.id]);

  const handleSave = useCallback(async () => {
    try {
      if (isMatchAmical) {
        const match = event as Match;
        
        // Mettre à jour les données du match
        await apiPut('/api/matches-amicaux', {
          id: match.id,
          ...matchData,
          categorie: matchData.categorie || undefined,
          details: matchData.stadium || matchData.address ? {
            stadium: matchData.stadium,
            address: matchData.address,
            dateTime: `${matchData.date} - ${matchData.time}`,
            competition: matchData.competition,
            terrainType: '',
            itineraryLink: '',
            rawText: '',
          } : null,
        });

        // Mettre à jour les extras (officiels)
        if (match.id) {
          // Mettre à jour les numéros dans officiels.json
          const updatePromises: Promise<void>[] = [];

          // Fonction helper pour vérifier et ajouter/mettre à jour un officiel
          const ensureOfficielInFile = (contact: { nom?: string; numero?: string }) => {
            const nom = contact.nom?.trim();
            const numero = contact.numero?.trim();
            
            if (nom && numero) {
              // Chercher l'officiel (comparaison insensible à la casse)
              const officiel = officiels.find((o) => o.nom.toLowerCase().trim() === nom.toLowerCase());
              
              // Si l'officiel n'existe pas OU si le numéro est différent, on ajoute/met à jour
              const officielTelephone = officiel?.telephone?.trim();
              if (!officiel || !officielTelephone || officielTelephone !== numero) {
                updatePromises.push(
                  apiPut('/api/officiels', { 
                    nom, 
                    telephone: numero 
                  }).then(() => {}).catch(() => {
                    logError('app.unhandled');
                  })
                );
              }
            }
          };

          // Vérifier tous les arbitres AFP
          matchExtras.arbitreTouche?.forEach((contact) => {
            ensureOfficielInFile(contact);
          });

          // Vérifier tous les encadrants
          matchExtras.contactEncadrants?.forEach((contact) => {
            ensureOfficielInFile(contact);
          });

          // Vérifier tous les accompagnateurs
          matchExtras.contactAccompagnateur?.forEach((contact) => {
            ensureOfficielInFile(contact);
          });

          await Promise.all(updatePromises);
          if (updatePromises.length > 0) {
            reloadOfficiels();
          }

          // Sauvegarder les extras
          await saveExtras(matchExtras);
        }
      } else if (isEntrainement) {
        // S'assurer que tous les encadrants sont dans officiels.json
        const updatePromises: Promise<void>[] = [];
        const ensureOfficielInFile = (contact: { nom?: string; numero?: string }) => {
          const nom = contact.nom?.trim();
          const numero = contact.numero?.trim() || '';
          
          if (nom) {
            const officiel = officiels.find((o) => o.nom.toLowerCase().trim() === nom.toLowerCase());
            const officielTelephone = officiel?.telephone?.trim() || '';
            if (!officiel || (numero && officielTelephone !== numero)) {
              updatePromises.push(
                apiPut('/api/officiels', { 
                  nom, 
                  telephone: numero 
                }).then(() => {}).catch(() => {
                  logError('app.unhandled');
                })
              );
            }
          }
        };

        encadrantsEntrainement.forEach((contact) => {
          ensureOfficielInFile(contact);
        });

        await Promise.all(updatePromises);
        if (updatePromises.length > 0) {
          reloadOfficiels();
        }

        await apiPut('/api/entrainements', {
          id: event.id,
          date: simpleEventData.date,
          time: simpleEventData.time,
          lieu: simpleEventData.lieu,
          categorie: simpleEventData.categorie || undefined,
          encadrants: encadrantsEntrainement.length > 0 ? encadrantsEntrainement : undefined,
        });
      } else if (isPlateau) {
        // S'assurer que tous les encadrants sont dans officiels.json
        const updatePromises: Promise<void>[] = [];
        const ensureOfficielInFile = (contact: { nom?: string; numero?: string }) => {
          const nom = contact.nom?.trim();
          const numero = contact.numero?.trim() || '';
          
          if (nom) {
            const officiel = officiels.find((o) => o.nom.toLowerCase().trim() === nom.toLowerCase());
            const officielTelephone = officiel?.telephone?.trim() || '';
            if (!officiel || (numero && officielTelephone !== numero)) {
              updatePromises.push(
                apiPut('/api/officiels', { 
                  nom, 
                  telephone: numero 
                }).then(() => {}).catch(() => {
                  logError('app.unhandled');
                })
              );
            }
          }
        };

        encadrantsPlateau.forEach((contact) => {
          ensureOfficielInFile(contact);
        });

        await Promise.all(updatePromises);
        if (updatePromises.length > 0) {
          reloadOfficiels();
        }

        await apiPut('/api/plateaux', {
          id: event.id,
          date: simpleEventData.date,
          time: simpleEventData.time,
          lieu: simpleEventData.lieu,
          categories: plateauCategories.length > 0 ? plateauCategories : undefined,
          encadrants: encadrantsPlateau.length > 0 ? encadrantsPlateau : undefined,
        });
      }

      toast.success('Événement modifié avec succès');
      onSave();
      onClose();
    } catch (error) {
      logError('app.unhandled', 'Error saving event:', error);
      toast.error('Erreur lors de la modification de l\'événement');
    }
  }, [
    isMatchAmical,
    isEntrainement,
    isPlateau,
    event,
    matchData,
    matchExtras,
    simpleEventData,
    plateauCategories,
    officiels,
    saveExtras,
    reloadOfficiels,
    onSave,
    onClose,
  ]);

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
        await apiDelete(endpoint);
        toast.success('Événement supprimé avec succès');
        onDelete?.();
        onClose();
      }
    } catch (error) {
      logError('app.unhandled', 'Error deleting event:', error);
      toast.error('Erreur lors de la suppression de l\'événement');
    } finally {
      setIsDeleting(false);
    }
  }, [isMatchAmical, isEntrainement, isPlateau, event.id, onDelete, onClose]);

  const getTitle = () => {
    if (isMatchAmical) return 'Modifier le match amical';
    if (isEntrainement) return 'Modifier l\'entraînement';
    if (isPlateau) return 'Modifier le plateau';
    return 'Modifier l\'événement';
  };

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto w-[95vw] sm:w-[90vw] md:w-[85vw] lg:w-[80vw]">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 sm:space-y-6 py-4">
          {isMatchAmical ? (
            <>
              {/* Champs de base du match amical */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="date">Date *</Label>
                  <Input
                    id="date"
                    value={matchData.date}
                    onChange={(e) => setMatchData({ ...matchData, date: e.target.value })}
                    placeholder="DD/MM/YYYY"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="time">Heure *</Label>
                  <Input
                    id="time"
                    value={matchData.time}
                    onChange={(e) => setMatchData({ ...matchData, time: e.target.value })}
                    placeholder="HH:MM"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="localTeam">Équipe locale *</Label>
                  <ClubCombobox
                    clubs={clubs}
                    value={matchData.localTeam}
                    onValueChange={(club) => {
                      setSelectedLocalClub(club);
                      setMatchData({ ...matchData, localTeam: club?.nom || '' });
                    }}
                    placeholder="Sélectionner un club local"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="awayTeam">Équipe adverse *</Label>
                  <ClubCombobox
                    clubs={clubs}
                    value={matchData.awayTeam}
                    onValueChange={(club) => {
                      setSelectedAwayClub(club);
                      setMatchData({ ...matchData, awayTeam: club?.nom || '' });
                    }}
                    placeholder="Sélectionner un club adverse"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="competition">Compétition *</Label>
                  <Input
                    id="competition"
                    value={matchData.competition}
                    onChange={(e) => setMatchData({ ...matchData, competition: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="categorie">Catégorie</Label>
                  <select
                    id="categorie"
                    value={matchData.categorie}
                    onChange={(e) => setMatchData({ ...matchData, categorie: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  >
                    <option value="">Sélectionner une catégorie</option>
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="venue">Lieu</Label>
                  <select
                    id="venue"
                    value={matchData.venue}
                    onChange={(e) => setMatchData({ ...matchData, venue: e.target.value as 'domicile' | 'extérieur' })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  >
                    <option value="domicile">Domicile</option>
                    <option value="extérieur">Extérieur</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="horaireRendezVous">Horaire rendez-vous</Label>
                  <Input
                    id="horaireRendezVous"
                    value={matchData.horaireRendezVous}
                    onChange={(e) => setMatchData({ ...matchData, horaireRendezVous: e.target.value })}
                    placeholder="HH:MM"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="stade-select">Sélectionner un stade</Label>
                  <StadeCombobox
                    stades={stades}
                    value={selectedStade?.nom}
                    onValueChange={setSelectedStade}
                    placeholder="Sélectionner un stade..."
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="stadium">Stade</Label>
                  <Input
                    id="stadium"
                    value={matchData.stadium}
                    onChange={(e) => setMatchData({ ...matchData, stadium: e.target.value })}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address">Adresse</Label>
                  <Input
                    id="address"
                    value={matchData.address}
                    onChange={(e) => setMatchData({ ...matchData, address: e.target.value })}
                  />
                </div>
              </div>

              {/* Extras : Arbitres AFP, Encadrants, Accompagnateurs */}
              <div className="pt-4 border-t space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-base font-semibold">Match complété et bien rempli</Label>
                  <Switch
                    checked={matchExtras.confirmed || false}
                    onCheckedChange={(checked) =>
                      setMatchExtras({ ...matchExtras, confirmed: checked })
                    }
                  />
                </div>

                <ContactListEditor
                  label={roleLabelWithClub('Arbitres', clubAbbr)}
                  contacts={matchExtras.arbitreTouche || []}
                  officiels={officiels}
                  assignmentType="officiel"
                  onContactsChange={(contacts) =>
                    setMatchExtras({ ...matchExtras, arbitreTouche: contacts })
                  }
                />

                <ContactListEditor
                  label={roleLabelWithClub('Encadrants', clubAbbr)}
                  contacts={matchExtras.contactEncadrants || []}
                  officiels={officiels}
                  assignmentType="encadrant"
                  onContactsChange={(contacts) =>
                    setMatchExtras({ ...matchExtras, contactEncadrants: contacts })
                  }
                />

                <ContactListEditor
                  label={roleLabelWithClub('Accompagnateurs', clubAbbr)}
                  contacts={matchExtras.contactAccompagnateur || []}
                  officiels={officiels}
                  assignmentType="accompagnateur"
                  onContactsChange={(contacts) =>
                    setMatchExtras({ ...matchExtras, contactAccompagnateur: contacts })
                  }
                />
              </div>
            </>
          ) : (
            <>
              {/* Formulaire pour entraînement/plateau */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="date">Date *</Label>
                  <Input
                    id="date"
                    value={simpleEventData.date}
                    onChange={(e) => setSimpleEventData({ ...simpleEventData, date: e.target.value })}
                    placeholder="DD/MM/YYYY"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="time">Heure *</Label>
                  <Input
                    id="time"
                    value={simpleEventData.time}
                    onChange={(e) => setSimpleEventData({ ...simpleEventData, time: e.target.value })}
                    placeholder="HH:MM"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="stade-select">Sélectionner un stade</Label>
                <StadeCombobox
                  stades={stades}
                  value={selectedStadeEntrainement?.nom}
                  onValueChange={setSelectedStadeEntrainement}
                  placeholder="Sélectionner un stade..."
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="lieu">Lieu *</Label>
                <Input
                  id="lieu"
                  value={simpleEventData.lieu}
                  onChange={(e) => setSimpleEventData({ ...simpleEventData, lieu: e.target.value })}
                />
              </div>

              {isEntrainement && (
                <div className="space-y-2">
                  <Label htmlFor="categorie-entrainement">Catégorie</Label>
                  <select
                    id="categorie-entrainement"
                    value={simpleEventData.categorie}
                    onChange={(e) => setSimpleEventData({ ...simpleEventData, categorie: e.target.value })}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  >
                    <option value="">Sélectionner une catégorie</option>
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {isPlateau && (
                <div className="space-y-2">
                  <Label>Catégories (plusieurs possibles)</Label>
                  <div className="border rounded-md p-3 max-h-48 overflow-y-auto space-y-2">
                    {categories.map((cat) => (
                      <div key={cat} className="flex items-center space-x-2">
                        <Checkbox
                          id={`cat-${cat}`}
                          checked={plateauCategories.includes(cat)}
                          onCheckedChange={(checked) => {
                            if (checked) {
                              setPlateauCategories([...plateauCategories, cat]);
                            } else {
                              setPlateauCategories(plateauCategories.filter(c => c !== cat));
                            }
                          }}
                        />
                        <Label
                          htmlFor={`cat-${cat}`}
                          className="text-sm font-normal cursor-pointer"
                        >
                          {cat}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {isEntrainement && (
                <ContactListEditor
                  label={roleLabelWithClub('Encadrants', clubAbbr)}
                  contacts={encadrantsEntrainement}
                  officiels={officiels}
                  assignmentType="encadrant"
                  onContactsChange={setEncadrantsEntrainement}
                  placeholder={`Sélectionner un encadrant ${clubAbbr}`.trim()}
                />
              )}
              
              {isPlateau && (
                <ContactListEditor
                  label={roleLabelWithClub('Encadrants', clubAbbr)}
                  contacts={encadrantsPlateau}
                  officiels={officiels}
                  assignmentType="encadrant"
                  onContactsChange={setEncadrantsPlateau}
                  placeholder={`Sélectionner un encadrant ${clubAbbr}`.trim()}
                />
              )}
            </>
          )}

          {event.id && <MatchAuditLogPanel matchId={event.id} />}
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2 sm:gap-0">
          {editable && onDelete && (
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
              className="w-full sm:w-auto order-3 sm:order-1"
            >
              {isDeleting ? 'Suppression...' : 'Supprimer'}
            </Button>
          )}
          <div className="flex gap-2 order-2 w-full sm:w-auto justify-end">
            <Button variant="outline" onClick={onClose} className="w-full sm:w-auto">
              Annuler
            </Button>
            {editable && (
              <Button onClick={handleSave} className="w-full sm:w-auto">
                Enregistrer
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
