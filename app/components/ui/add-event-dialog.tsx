'use client';

import { useState, memo, useEffect } from 'react';
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
import { useOfficiels } from '@/hooks/useOfficiels';
import { useEncadrants } from '@/hooks/useEncadrants';
import { useAccompagnateurs } from '@/hooks/useAccompagnateurs';
import { useStades, Stade } from '@/hooks/useStades';
import { useClubs, Club } from '@/hooks/useClubs';
import { useCategories } from '@/hooks/useCategories';
import { ContactOfficiel } from '@/hooks/useMatchExtras';
import { apiPost } from '@/lib/utils/api';
import { toast } from 'sonner';
import { Checkbox } from '@/components/ui/checkbox';
import { useAppSettings } from '@/hooks/useAppSettings';
import { roleLabelWithClub } from '@/lib/settings';

export type EventType = 'officiel' | 'amical' | 'entrainement' | 'plateau';

interface AddEventDialogProps {
  open: boolean;
  onClose: () => void;
  eventType: EventType;
  onSuccess: () => void;
}

export const AddEventDialog = memo(function AddEventDialog({
  open,
  onClose,
  eventType,
  onSuccess,
}: AddEventDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const { settings } = useAppSettings();
  const clubAbbr = settings.clubAbbreviation;
  const { officiels } = useOfficiels();
  const { encadrants } = useEncadrants();
  const { accompagnateurs } = useAccompagnateurs();
  const { stades } = useStades();
  const { clubs } = useClubs();
  const { categories } = useCategories();
  
  // Champs communs
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  
  // Champs pour match amical
  const [selectedLocalClub, setSelectedLocalClub] = useState<Club | null>(null);
  const [selectedAwayClub, setSelectedAwayClub] = useState<Club | null>(null);
  const [localTeam, setLocalTeam] = useState('');
  const [awayTeam, setAwayTeam] = useState('');
  const [venue, setVenue] = useState<'domicile' | 'extérieur'>('domicile');
  // Competition est automatiquement "match amical" pour les matchs amicaux
  const competition = eventType === 'amical' ? 'Match amical' : '';
  const [competitionOfficiel, setCompetitionOfficiel] = useState('Championnat');
  const [horaireRendezVous, setHoraireRendezVous] = useState('');
  const [selectedStade, setSelectedStade] = useState<Stade | null>(null);
  const [stadium, setStadium] = useState('');
  const [address, setAddress] = useState('');
  
  // Extras pour match amical (arbitres, encadrants, accompagnateurs)
  const [confirmed, setConfirmed] = useState(false);
  const [arbitreTouche, setArbitreTouche] = useState<ContactOfficiel[]>([]);
  const [contactEncadrants, setContactEncadrants] = useState<ContactOfficiel[]>([]);
  const [contactAccompagnateur, setContactAccompagnateur] = useState<ContactOfficiel[]>([]);
  
  // Champs pour entraînement/plateau
  const [selectedStadeEntrainement, setSelectedStadeEntrainement] = useState<Stade | null>(null);
  const [lieu, setLieu] = useState('');
  const [categorieEntrainement, setCategorieEntrainement] = useState('');
  const [categoriesPlateau, setCategoriesPlateau] = useState<string[]>([]);
  const [encadrantsEntrainement, setEncadrantsEntrainement] = useState<ContactOfficiel[]>([]);
  const [encadrantsPlateau, setEncadrantsPlateau] = useState<ContactOfficiel[]>([]);
  
  // Catégorie pour match amical
  const [categorieMatchAmical, setCategorieMatchAmical] = useState('');
  const [rightsAttested, setRightsAttested] = useState(false);
  const [csvFile, setCsvFile] = useState<File | null>(null);

  // Quand un club local est sélectionné, mettre à jour localTeam
  useEffect(() => {
    if (selectedLocalClub) {
      setLocalTeam(selectedLocalClub.nom);
    }
  }, [selectedLocalClub]);

  // Quand un club adverse est sélectionné, mettre à jour awayTeam
  useEffect(() => {
    if (selectedAwayClub) {
      setAwayTeam(selectedAwayClub.nom);
    }
  }, [selectedAwayClub]);

  // Quand un stade est sélectionné pour match amical, remplir les champs
  useEffect(() => {
    if (selectedStade) {
      setStadium(selectedStade.nom);
      setAddress(selectedStade.adresse || '');
    }
  }, [selectedStade]);

  // Quand un stade est sélectionné pour entraînement, remplir le champ lieu
  useEffect(() => {
    if (selectedStadeEntrainement) {
      const lieuText = selectedStadeEntrainement.adresse 
        ? `${selectedStadeEntrainement.nom} - ${selectedStadeEntrainement.adresse}`
        : selectedStadeEntrainement.nom;
      setLieu(lieuText);
    }
  }, [selectedStadeEntrainement]);

  // Initialiser la date avec aujourd'hui au format DD/MM/YYYY
  useEffect(() => {
    if (open && !date) {
      const today = new Date();
      const day = String(today.getDate()).padStart(2, '0');
      const month = String(today.getMonth() + 1).padStart(2, '0');
      const year = today.getFullYear();
      setDate(`${day}/${month}/${year}`);
    }
  }, [open, date]);

  const resetForm = () => {
    setDate('');
    setTime('');
    setSelectedLocalClub(null);
    setSelectedAwayClub(null);
    setLocalTeam('');
    setAwayTeam('');
    setLocalTeam('');
    setAwayTeam('');
    setVenue('domicile');
    setHoraireRendezVous('');
    setSelectedStade(null);
    setStadium('');
    setAddress('');
    setSelectedStadeEntrainement(null);
    setLieu('');
    setCategorieEntrainement('');
    setCategoriesPlateau([]);
    setCategorieMatchAmical('');
    setCompetitionOfficiel('Championnat');
    setRightsAttested(false);
    setCsvFile(null);
    setEncadrantsEntrainement([]);
    setEncadrantsPlateau([]);
    setConfirmed(false);
    setArbitreTouche([]);
    setContactEncadrants([]);
    setContactAccompagnateur([]);
  };

  const handleClose = () => {
    resetForm();
    onClose();
  };

  const handleSubmit = async () => {
    setIsLoading(true);
    
    try {
      let endpoint = '';
      let payload: Record<string, unknown> = { date, time };

      if (eventType === 'officiel' && csvFile) {
        if (!rightsAttested) {
          toast.error('Attestez que le club est autorisé à utiliser ces informations');
          setIsLoading(false);
          return;
        }
        const csvText = await csvFile.text();
        await apiPost('/api/planning/official-import', { csvText, rightsAttested: true });
        toast.success('Calendrier officiel importé');
        resetForm();
        onSuccess();
        handleClose();
        return;
      }

      if (eventType === 'amical' || eventType === 'officiel') {
        if (!localTeam || !awayTeam) {
          toast.error('Veuillez remplir tous les champs obligatoires');
          setIsLoading(false);
          return;
        }
        if (eventType === 'officiel' && !rightsAttested) {
          toast.error('Attestez que le club est autorisé à utiliser ces informations');
          setIsLoading(false);
          return;
        }

        const matchCompetition = eventType === 'amical' ? competition : competitionOfficiel.trim();
        if (eventType === 'officiel' && !matchCompetition) {
          toast.error('Indiquez la compétition');
          setIsLoading(false);
          return;
        }

        endpoint = eventType === 'amical' ? '/api/matches-amicaux' : '/api/planning/events/officiel';
        payload = {
          ...payload,
          type: eventType,
          localTeam,
          awayTeam,
          venue,
          competition: matchCompetition,
          categorie: categorieMatchAmical || undefined,
          horaireRendezVous: horaireRendezVous || time,
          details: stadium || address ? {
            stadium: stadium || '',
            address: address || '',
            dateTime: `${date} - ${time}`,
            competition: matchCompetition,
            terrainType: '',
            itineraryLink: '',
            rawText: '',
          } : null,
          confirmed,
          arbitreTouche: arbitreTouche.length > 0 ? arbitreTouche : undefined,
          contactEncadrants: contactEncadrants.length > 0 ? contactEncadrants : undefined,
          contactAccompagnateur: contactAccompagnateur.length > 0 ? contactAccompagnateur : undefined,
          ...(eventType === 'officiel' ? { rightsAttested: true } : {}),
        };

        await apiPost(endpoint, payload);
      } else if (eventType === 'entrainement') {
        // Validation entraînement
        if (!lieu) {
          toast.error('Veuillez remplir tous les champs obligatoires');
          setIsLoading(false);
          return;
        }

        endpoint = '/api/entrainements';
        payload = {
          ...payload,
          lieu,
          categorie: categorieEntrainement || undefined,
          encadrants: encadrantsEntrainement.length > 0 ? encadrantsEntrainement : undefined,
        };

        await apiPost(endpoint, payload);
      } else if (eventType === 'plateau') {
        // Validation plateau
        if (!lieu) {
          toast.error('Veuillez remplir tous les champs obligatoires');
          setIsLoading(false);
          return;
        }

        endpoint = '/api/plateaux';
        payload = {
          ...payload,
          lieu,
          categories: categoriesPlateau.length > 0 ? categoriesPlateau : undefined,
          encadrants: encadrantsPlateau.length > 0 ? encadrantsPlateau : undefined,
        };

        await apiPost(endpoint, payload);
      }
      
      toast.success(
        eventType === 'amical' 
          ? 'Match amical ajouté avec succès'
          : eventType === 'officiel'
          ? 'Match officiel ajouté avec succès'
          : eventType === 'entrainement'
          ? 'Entraînement ajouté avec succès'
          : 'Plateau ajouté avec succès'
      );
      
      resetForm();
      onSuccess();
      handleClose();
    } catch (error) {
      console.error('Error adding event:', error);
      toast.error('Erreur lors de l\'ajout de l\'événement');
    } finally {
      setIsLoading(false);
    }
  };

  const getTitle = () => {
    switch (eventType) {
      case 'amical':
        return 'Ajouter un match amical';
      case 'officiel':
        return 'Ajouter un match officiel';
      case 'entrainement':
        return 'Ajouter un entraînement';
      case 'plateau':
        return 'Ajouter un plateau';
      default:
        return 'Ajouter un événement';
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto w-[95vw] sm:w-[90vw] md:w-[85vw] lg:w-[80vw]">
        <DialogHeader>
          <DialogTitle>{getTitle()}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Champs communs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="date">Date *</Label>
              <Input
                id="date"
                type="text"
                placeholder="DD/MM/YYYY"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="time">Heure *</Label>
              <Input
                id="time"
                type="text"
                placeholder="HH:MM"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
          </div>

          {/* Champs spécifiques au match amical / officiel */}
          {(eventType === 'amical' || eventType === 'officiel') && (
            <>
              {eventType === 'officiel' && (
                <div className="space-y-3 rounded-md border p-3">
                  <Label htmlFor="official-csv">Importer un calendrier CSV (optionnel)</Label>
                  <p className="text-xs text-muted-foreground">
                    Colonnes : date, time, localTeam, awayTeam, venue, competition, categorie, stadium, address.
                    Le club atteste la provenance. Les URL SportCorico sont refusées.
                  </p>
                  <Input
                    id="official-csv"
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                  />
                </div>
              )}
              {eventType === 'officiel' && (
                <div className="space-y-2">
                  <Label htmlFor="competition-officiel">Compétition *</Label>
                  <Input
                    id="competition-officiel"
                    value={competitionOfficiel}
                    onChange={(e) => setCompetitionOfficiel(e.target.value)}
                    placeholder="Championnat"
                  />
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="localTeam">Équipe locale *</Label>
                  <ClubCombobox
                    clubs={clubs}
                    value={localTeam}
                    onValueChange={(club) => {
                      setSelectedLocalClub(club);
                      if (club) {
                        setLocalTeam(club.nom);
                      } else {
                        setLocalTeam('');
                      }
                    }}
                    placeholder="Sélectionner un club local"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="awayTeam">Équipe adverse *</Label>
                  <ClubCombobox
                    clubs={clubs}
                    value={awayTeam}
                    onValueChange={(club) => {
                      setSelectedAwayClub(club);
                      if (club) {
                        setAwayTeam(club.nom);
                      } else {
                        setAwayTeam('');
                      }
                    }}
                    placeholder="Sélectionner un club adverse"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="venue">Lieu</Label>
                  <select
                    id="venue"
                    value={venue}
                    onChange={(e) => setVenue(e.target.value as 'domicile' | 'extérieur')}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
                  >
                    <option value="domicile">Domicile</option>
                    <option value="extérieur">Extérieur</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="categorie-amical">Catégorie</Label>
                  <select
                    id="categorie-amical"
                    value={categorieMatchAmical}
                    onChange={(e) => setCategorieMatchAmical(e.target.value)}
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
                  <Label htmlFor="horaireRendezVous">Horaire rendez-vous</Label>
                  <Input
                    id="horaireRendezVous"
                    value={horaireRendezVous}
                    onChange={(e) => setHoraireRendezVous(e.target.value)}
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
                    value={stadium}
                    onChange={(e) => setStadium(e.target.value)}
                    placeholder="Ex: Stade Poissonniers"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address">Adresse</Label>
                  <Input
                    id="address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Ex: RUE JEAN COCTEAU - 75018 - PARIS"
                  />
                </div>
              </div>

              {/* Extras : Arbitres AFP, Encadrants, Accompagnateurs */}
              <div className="pt-4 border-t space-y-4">
                {eventType === 'officiel' && (
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Checkbox
                      id="rightsAttested"
                      checked={rightsAttested}
                      onCheckedChange={(value) => setRightsAttested(value === true)}
                    />
                    <div className="space-y-1">
                      <Label htmlFor="rightsAttested" className="text-sm font-medium leading-none">
                        J’atteste que le club est autorisé à utiliser ces informations *
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Saisie manuelle ou CSV fourni par le club — pas d’import depuis une source tierce non licenciée.
                      </p>
                    </div>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5 flex-1 min-w-0">
                    <Label htmlFor="confirmed" className="text-sm sm:text-base">Match complété et bien rempli</Label>
                    <p className="text-xs sm:text-sm text-muted-foreground">
                      Marquer ce match comme complété lorsque toutes les informations sont complètes
                    </p>
                  </div>
                  <Switch
                    id="confirmed"
                    checked={confirmed}
                    onCheckedChange={setConfirmed}
                    className="flex-shrink-0"
                  />
                </div>

                <ContactListEditor
                  label={roleLabelWithClub('Arbitres', clubAbbr)}
                  contacts={arbitreTouche}
                  officiels={officiels}
                  assignmentType="officiel"
                  onContactsChange={setArbitreTouche}
                  placeholder={`Sélectionner un arbitre ${clubAbbr}`.trim()}
                />

                <ContactListEditor
                  label={roleLabelWithClub('Encadrants', clubAbbr)}
                  contacts={contactEncadrants}
                  officiels={encadrants}
                  assignmentType="encadrant"
                  onContactsChange={setContactEncadrants}
                  placeholder={`Sélectionner un encadrant ${clubAbbr}`.trim()}
                />

                <ContactListEditor
                  label={roleLabelWithClub('Accompagnateurs', clubAbbr)}
                  contacts={contactAccompagnateur}
                  officiels={accompagnateurs}
                  assignmentType="accompagnateur"
                  onContactsChange={setContactAccompagnateur}
                  placeholder={`Sélectionner un accompagnateur ${clubAbbr}`.trim()}
                />
              </div>
            </>
          )}

          {/* Champs pour entraînement */}
          {eventType === 'entrainement' && (
            <>
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
                  value={lieu}
                  onChange={(e) => setLieu(e.target.value)}
                  placeholder="Ex: Stade Poissonniers, Terrain 2"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="categorie-entrainement">Catégorie</Label>
                <select
                  id="categorie-entrainement"
                  value={categorieEntrainement}
                  onChange={(e) => setCategorieEntrainement(e.target.value)}
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

              <ContactListEditor
                label={roleLabelWithClub('Encadrants', clubAbbr)}
                contacts={encadrantsEntrainement}
                officiels={encadrants}
                assignmentType="encadrant"
                onContactsChange={setEncadrantsEntrainement}
                placeholder={`Sélectionner un encadrant ${clubAbbr}`.trim()}
              />
            </>
          )}

          {/* Champs pour plateau */}
          {eventType === 'plateau' && (
            <>
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
                  value={lieu}
                  onChange={(e) => setLieu(e.target.value)}
                  placeholder="Ex: Stade Poissonniers, Terrain 2"
                />
              </div>

              <div className="space-y-2">
                <Label>Catégories (plusieurs possibles)</Label>
                <div className="border rounded-md p-3 max-h-48 overflow-y-auto space-y-2">
                  {categories.map((cat) => (
                    <div key={cat} className="flex items-center space-x-2">
                      <Checkbox
                        id={`cat-plateau-${cat}`}
                        checked={categoriesPlateau.includes(cat)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setCategoriesPlateau([...categoriesPlateau, cat]);
                          } else {
                            setCategoriesPlateau(categoriesPlateau.filter(c => c !== cat));
                          }
                        }}
                      />
                      <Label
                        htmlFor={`cat-plateau-${cat}`}
                        className="text-sm font-normal cursor-pointer"
                      >
                        {cat}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              <ContactListEditor
                label={roleLabelWithClub('Encadrants', clubAbbr)}
                contacts={encadrantsPlateau}
                officiels={encadrants}
                assignmentType="encadrant"
                onContactsChange={setEncadrantsPlateau}
                placeholder={`Sélectionner un encadrant ${clubAbbr}`.trim()}
              />
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isLoading}>
            Annuler
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? 'Ajout...' : 'Ajouter'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
