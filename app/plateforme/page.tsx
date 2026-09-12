'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Label } from '@/app/components/ui/label';
import { PageContainer, PageHeader, SectionCard, StatusPill } from '@/app/components/layout/page-primitives';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/app/components/ui/dialog';
import { Switch } from '@/app/components/ui/switch';
import { LoadingSpinner } from '@/app/components/ui/loading-spinner';
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Database,
  Palette,
  Plus,
  Save,
  ShieldAlert,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { DEFAULT_APP_SETTINGS } from '@/lib/settings';
import { apiGet, apiPatch, apiPost } from '@/lib/utils/api';
import { OpponentClubsSection } from '@/app/components/plateforme/OpponentClubsSection';

interface PlatformAdmin {
  id: number;
  email: string;
  nom: string;
}

interface PlatformMeResponse {
  admin: PlatformAdmin;
  encryptionConfigured: boolean;
  nodeEnv: string;
}

interface ClubRow {
  id: string;
  name: string;
  active: boolean;
  matchesUrlKey: string;
  scraperClubName: string;
  createdAt: string;
}

interface AdminRow {
  id: number;
  email: string;
  nom: string;
  active: boolean;
  createdAt: string;
}

export default function PlatformDashboardPage() {
  const router = useRouter();
  const [admin, setAdmin] = useState<PlatformAdmin | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);
  const [encryptionStatus, setEncryptionStatus] = useState<{ configured: boolean; nodeEnv: string } | null>(null);

  const [clubs, setClubs] = useState<ClubRow[]>([]);
  const [isLoadingClubs, setIsLoadingClubs] = useState(true);

  const [expandedClubId, setExpandedClubId] = useState<string | null>(null);
  const [adminsByClub, setAdminsByClub] = useState<Record<string, AdminRow[]>>({});
  const [isLoadingAdmins, setIsLoadingAdmins] = useState(false);
  const [isSavingScrapingClubId, setIsSavingScrapingClubId] = useState<string | null>(null);

  const [isNewClubOpen, setIsNewClubOpen] = useState(false);
  const [newClubId, setNewClubId] = useState('');
  const [newClubName, setNewClubName] = useState('');
  const [newClubAbbreviation, setNewClubAbbreviation] = useState('');
  const [newClubLogo, setNewClubLogo] = useState('');
  const [newClubPrimaryColor, setNewClubPrimaryColor] = useState(DEFAULT_APP_SETTINGS.primaryColor);
  const [newClubSecondaryColor, setNewClubSecondaryColor] = useState(DEFAULT_APP_SETTINGS.accentColor);
  const [newClubMatchesUrlKey, setNewClubMatchesUrlKey] = useState('');
  const [newClubScraperClubName, setNewClubScraperClubName] = useState('');
  const [isCreatingClub, setIsCreatingClub] = useState(false);

  const [newAdminClubId, setNewAdminClubId] = useState<string | null>(null);
  const [newAdminEmail, setNewAdminEmail] = useState('');
  const [newAdminPassword, setNewAdminPassword] = useState('');
  const [newAdminNom, setNewAdminNom] = useState('');
  const [isCreatingAdmin, setIsCreatingAdmin] = useState(false);

  const loadClubs = useCallback(async () => {
    setIsLoadingClubs(true);
    try {
      const data = await apiGet<{ clubs: ClubRow[] }>('/api/plateforme/clubs');
      setClubs(data.clubs);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de charger les clubs');
    } finally {
      setIsLoadingClubs(false);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const data = await apiGet<PlatformMeResponse>('/api/plateforme/me');
        setAdmin(data.admin);
        setEncryptionStatus({ configured: data.encryptionConfigured, nodeEnv: data.nodeEnv });
      } catch {
        router.replace('/plateforme/login');
        return;
      } finally {
        setIsCheckingAuth(false);
      }
    })();
  }, [router]);

  useEffect(() => {
    if (admin) {
      void loadClubs();
    }
  }, [admin, loadClubs]);

  const loadAdmins = useCallback(async (clubId: string) => {
    setIsLoadingAdmins(true);
    try {
      const data = await apiGet<{ admins: AdminRow[] }>(`/api/plateforme/clubs/${clubId}/admins`);
      setAdminsByClub((prev) => ({ ...prev, [clubId]: data.admins }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de charger les administrateurs');
    } finally {
      setIsLoadingAdmins(false);
    }
  }, []);

  const handleToggleExpand = (clubId: string) => {
    if (expandedClubId === clubId) {
      setExpandedClubId(null);
      return;
    }
    setExpandedClubId(clubId);
    if (!adminsByClub[clubId]) {
      void loadAdmins(clubId);
    }
  };

  const updateClubDraft = (clubId: string, patch: Partial<Pick<ClubRow, 'matchesUrlKey' | 'scraperClubName'>>) => {
    setClubs((current) => current.map((club) => (club.id === clubId ? { ...club, ...patch } : club)));
  };

  const handleSaveScraping = async (club: ClubRow) => {
    setIsSavingScrapingClubId(club.id);
    try {
      await apiPatch(`/api/plateforme/clubs/${club.id}`, {
        matchesUrlKey: club.matchesUrlKey.trim(),
        scraperClubName: club.scraperClubName.trim(),
      });
      toast.success('Source de scraping enregistrée');
      await loadClubs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible d\'enregistrer la source de scraping');
    } finally {
      setIsSavingScrapingClubId(null);
    }
  };

  const handleToggleClubActive = async (club: ClubRow) => {
    try {
      await apiPatch(`/api/plateforme/clubs/${club.id}`, { active: !club.active });
      toast.success(club.active ? 'Club désactivé' : 'Club activé');
      await loadClubs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur inconnue');
    }
  };

  const resetNewClubForm = () => {
    setNewClubId('');
    setNewClubName('');
    setNewClubAbbreviation('');
    setNewClubLogo('');
    setNewClubPrimaryColor(DEFAULT_APP_SETTINGS.primaryColor);
    setNewClubSecondaryColor(DEFAULT_APP_SETTINGS.accentColor);
    setNewClubMatchesUrlKey('');
    setNewClubScraperClubName('');
  };

  const handleLogoUpload = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast.error('Veuillez sélectionner une image valide');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        setNewClubLogo(result);
      }
    };
    reader.onerror = () => {
      toast.error('Impossible de lire le fichier image');
    };
    reader.readAsDataURL(file);
  };

  const handleCreateClub = async () => {
    if (!newClubAbbreviation.trim()) {
      toast.error("L'abréviation du club est requise");
      return;
    }

    setIsCreatingClub(true);
    try {
      await apiPost('/api/plateforme/clubs', {
        id: newClubId.trim(),
        name: newClubName.trim(),
        abbreviation: newClubAbbreviation.trim(),
        logo: newClubLogo.trim(),
        primaryColor: newClubPrimaryColor,
        secondaryColor: newClubSecondaryColor,
        matchesUrlKey: newClubMatchesUrlKey.trim(),
        scraperClubName: newClubScraperClubName.trim(),
      });
      toast.success('Club créé');
      setIsNewClubOpen(false);
      resetNewClubForm();
      await loadClubs();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de créer le club');
    } finally {
      setIsCreatingClub(false);
    }
  };

  const handleToggleAdminActive = async (clubId: string, target: AdminRow) => {
    try {
      await apiPatch(`/api/plateforme/clubs/${clubId}/admins/${target.id}`, {
        active: !target.active,
      });
      toast.success(target.active ? 'Administrateur désactivé' : 'Administrateur réactivé');
      await loadAdmins(clubId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Erreur inconnue');
    }
  };

  const handleCreateAdmin = async () => {
    if (!newAdminClubId) return;
    setIsCreatingAdmin(true);
    try {
      await apiPost(`/api/plateforme/clubs/${newAdminClubId}/admins`, {
        email: newAdminEmail.trim(),
        password: newAdminPassword,
        nom: newAdminNom.trim(),
      });
      toast.success('Administrateur créé');
      const clubId = newAdminClubId;
      setNewAdminClubId(null);
      setNewAdminEmail('');
      setNewAdminPassword('');
      setNewAdminNom('');
      await loadAdmins(clubId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Impossible de créer l\'administrateur');
    } finally {
      setIsCreatingAdmin(false);
    }
  };

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <LoadingSpinner size={40} text="Chargement..." />
      </div>
    );
  }

  if (!admin) {
    return null;
  }

  return (
    <>
      <PageContainer>
        <PageHeader
          icon={<Building2 />}
          title="Administration plateforme"
          description="Gérez les tenants et leur source de scraping. Ces paramètres techniques sont réservés à la plateforme."
        />

        {encryptionStatus && !encryptionStatus.configured && (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive"
          >
            <ShieldAlert className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">APP_ENCRYPTION_KEY n&apos;est pas configurée</p>
              <p className="mt-1 text-destructive/90">
                {encryptionStatus.nodeEnv === 'production'
                  ? "Les messages de chat et les mots de passe SMTP sont enregistrés en clair sur cette instance de production. Définissez APP_ENCRYPTION_KEY et redémarrez l'application dès que possible."
                  : "Comportement toléré en développement uniquement : les messages de chat et les mots de passe SMTP sont enregistrés en clair. Définissez APP_ENCRYPTION_KEY avant toute mise en production."}
              </p>
            </div>
          </div>
        )}
        <SectionCard
          icon={<Building2 />}
          title="Clubs"
          description="Gérez les tenants et leur source de scraping."
          actions={
            <Button size="sm" onClick={() => setIsNewClubOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Nouveau club
            </Button>
          }
        >
            {isLoadingClubs ? (
              <LoadingSpinner size={32} text="Chargement..." className="py-10" />
            ) : clubs.length === 0 ? (
              <p className="text-muted-foreground text-center py-8">Aucun club</p>
            ) : (
              <div className="space-y-2">
                {clubs.map((club) => {
                  const isExpanded = expandedClubId === club.id;
                  const admins = adminsByClub[club.id] ?? [];
                  const isSavingScraping = isSavingScrapingClubId === club.id;

                  return (
                    <div key={club.id} className="overflow-hidden rounded-xl border bg-card">
                      <div className="flex items-center justify-between gap-3 p-3">
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors hover:bg-secondary-soft"
                          onClick={() => handleToggleExpand(club.id)}
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 shrink-0 text-primary" />
                          ) : (
                            <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0">
                            <p className="flex items-center gap-2 truncate font-medium text-foreground">
                              {club.name}
                              {!club.active && <StatusPill tone="danger">Désactivé</StatusPill>}
                            </p>
                            <p className="truncate font-mono text-sm text-muted-foreground">{club.id}</p>
                          </div>
                        </button>
                        <div className="flex items-center gap-2 shrink-0">
                          <Label htmlFor={`club-active-${club.id}`} className="text-xs text-muted-foreground">
                            Actif
                          </Label>
                          <Switch
                            id={`club-active-${club.id}`}
                            checked={club.active}
                            onCheckedChange={() => handleToggleClubActive(club)}
                          />
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="space-y-4 border-t bg-secondary-soft p-3">
                          <div className="space-y-4 rounded-xl border bg-card p-4">
                            <div>
                              <p className="flex items-center gap-2 text-sm font-semibold">
                                <Database className="h-4 w-4 text-primary" />
                                Source de scraping
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                Configuration technique réservée au Superadmin plateforme. Elle n&apos;est pas modifiable depuis l&apos;administration du club.
                              </p>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                              <div className="space-y-2">
                                <Label htmlFor={`matches-url-key-${club.id}`}>matchesUrlKey</Label>
                                <Input
                                  id={`matches-url-key-${club.id}`}
                                  value={club.matchesUrlKey}
                                  onChange={(event) => updateClubDraft(club.id, { matchesUrlKey: event.target.value })}
                                  placeholder="academie-football-paris-18"
                                  disabled={isSavingScraping}
                                />
                                <p className="text-xs text-muted-foreground">
                                  Clé utilisée dans l&apos;URL de la source SportCorico.
                                </p>
                              </div>
                              <div className="space-y-2">
                                <Label htmlFor={`scraper-club-name-${club.id}`}>scraperClubName</Label>
                                <Input
                                  id={`scraper-club-name-${club.id}`}
                                  value={club.scraperClubName}
                                  onChange={(event) => updateClubDraft(club.id, { scraperClubName: event.target.value })}
                                  placeholder="Nom exact utilisé par la source"
                                  disabled={isSavingScraping}
                                />
                                <p className="text-xs text-muted-foreground">
                                  Nom attendu pour vérifier que les matchs récupérés appartiennent bien à ce club.
                                </p>
                              </div>
                            </div>

                            <div className="flex justify-end">
                              <Button
                                size="sm"
                                onClick={() => handleSaveScraping(club)}
                                disabled={isSavingScraping}
                              >
                                <Save className="h-4 w-4 mr-2" />
                                {isSavingScraping ? 'Enregistrement...' : 'Enregistrer la source'}
                              </Button>
                            </div>
                          </div>

                          <div className="space-y-3">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                              <p className="flex items-center gap-2 text-sm font-medium">
                                <ShieldCheck className="h-4 w-4 text-primary" />
                                Administrateurs
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setNewAdminClubId(club.id)}
                              >
                                <Plus className="h-4 w-4 mr-2" />
                                Nouvel administrateur
                              </Button>
                            </div>

                            {isLoadingAdmins && !adminsByClub[club.id] ? (
                              <LoadingSpinner size={24} text="Chargement..." className="py-4" />
                            ) : admins.length === 0 ? (
                              <p className="text-muted-foreground text-sm py-2">Aucun administrateur</p>
                            ) : (
                              <div className="space-y-2">
                                {admins.map((row) => (
                                  <div
                                    key={row.id}
                                    className="flex items-center justify-between rounded-lg border bg-card p-2 text-sm"
                                  >
                                    <div className="min-w-0">
                                      <p className="flex items-center gap-2 truncate font-medium">
                                        {row.nom}
                                        {!row.active && <StatusPill tone="danger">Désactivé</StatusPill>}
                                      </p>
                                      <p className="truncate text-muted-foreground">{row.email}</p>
                                    </div>
                                    <div className="flex items-center gap-2 ml-4 shrink-0">
                                      <Switch
                                        checked={row.active}
                                        onCheckedChange={() => handleToggleAdminActive(club.id, row)}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>

                          <OpponentClubsSection clubId={club.id} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
        </SectionCard>
      </PageContainer>

      <Dialog
        open={isNewClubOpen}
        onOpenChange={(open) => {
          setIsNewClubOpen(open);
          if (!open) resetNewClubForm();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nouveau club</DialogTitle>
            <DialogDescription>
              Créez un nouveau club (tenant), son identité visuelle et sa source de scraping côté plateforme.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-club-id">Identifiant (slug)</Label>
              <Input
                id="new-club-id"
                placeholder="mon-club"
                value={newClubId}
                onChange={(event) => setNewClubId(event.target.value.toLowerCase())}
                disabled={isCreatingClub}
              />
              <p className="text-xs text-muted-foreground">
                Lettres minuscules, chiffres et tirets uniquement (2 à 64 caractères).
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-club-name">Nom du club *</Label>
              <Input
                id="new-club-name"
                placeholder="Mon Club de Football"
                value={newClubName}
                onChange={(event) => setNewClubName(event.target.value)}
                disabled={isCreatingClub}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-club-abbr">Abréviation du club *</Label>
              <Input
                id="new-club-abbr"
                placeholder="Ex : AFP"
                value={newClubAbbreviation}
                onChange={(event) => setNewClubAbbreviation(event.target.value)}
                maxLength={16}
                disabled={isCreatingClub}
              />
              <p className="text-xs text-muted-foreground">
                Utilisée pour les libellés de rôle : Arbitre {newClubAbbreviation.trim() || 'AFP'},
                Encadrant {newClubAbbreviation.trim() || 'AFP'}, Accompagnateur {newClubAbbreviation.trim() || 'AFP'}.
              </p>
            </div>
            <div className="rounded-lg border p-3 space-y-3">
              <p className="text-sm font-semibold flex items-center gap-2">
                <Palette className="h-4 w-4" />
                Identité visuelle
              </p>
              <div className="space-y-2">
                <Label htmlFor="new-club-logo">Logo du club (upload ou URL)</Label>
                <Input
                  id="new-club-logo"
                  value={newClubLogo}
                  onChange={(event) => setNewClubLogo(event.target.value)}
                  placeholder="https://... ou data:image/..."
                  disabled={isCreatingClub}
                />
                <Input
                  type="file"
                  accept="image/*"
                  disabled={isCreatingClub}
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    handleLogoUpload(file);
                  }}
                />
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  <Upload className="h-3.5 w-3.5" />
                  Le fichier est converti et sauvegardé dans la base.
                </p>
                {newClubLogo && (
                  <div className="flex items-center gap-3 pt-1">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={newClubLogo} alt="Logo du club" className="w-16 h-16 rounded-full object-cover border" />
                    <span className="text-sm text-muted-foreground">Aperçu du logo</span>
                  </div>
                )}
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-club-primary-color">Couleur principale</Label>
                  <Input
                    id="new-club-primary-color"
                    type="color"
                    value={newClubPrimaryColor}
                    onChange={(event) => setNewClubPrimaryColor(event.target.value)}
                    className="h-10 p-1"
                    disabled={isCreatingClub}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-club-secondary-color">Couleur secondaire</Label>
                  <Input
                    id="new-club-secondary-color"
                    type="color"
                    value={newClubSecondaryColor}
                    onChange={(event) => setNewClubSecondaryColor(event.target.value)}
                    className="h-10 p-1"
                    disabled={isCreatingClub}
                  />
                </div>
              </div>
            </div>
            <div className="rounded-lg border p-3 space-y-3">
              <p className="text-sm font-semibold flex items-center gap-2">
                <Database className="h-4 w-4" />
                Source de scraping
              </p>
              <div className="space-y-2">
                <Label htmlFor="new-club-matches-url-key">matchesUrlKey</Label>
                <Input
                  id="new-club-matches-url-key"
                  placeholder="academie-football-paris-18"
                  value={newClubMatchesUrlKey}
                  onChange={(event) => setNewClubMatchesUrlKey(event.target.value.toLowerCase())}
                  disabled={isCreatingClub}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-club-scraper-name">scraperClubName</Label>
                <Input
                  id="new-club-scraper-name"
                  placeholder="Nom exact utilisé par la source"
                  value={newClubScraperClubName}
                  onChange={(event) => setNewClubScraperClubName(event.target.value)}
                  disabled={isCreatingClub}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsNewClubOpen(false)} disabled={isCreatingClub}>
              Annuler
            </Button>
            <Button
              onClick={handleCreateClub}
              disabled={isCreatingClub || !newClubId.trim() || !newClubName.trim() || !newClubAbbreviation.trim()}
            >
              {isCreatingClub ? 'Création...' : 'Créer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={newAdminClubId !== null} onOpenChange={(open) => !open && setNewAdminClubId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouvel administrateur</DialogTitle>
            <DialogDescription>
              Créez un compte administrateur pour ce club.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="new-admin-nom">Nom</Label>
              <Input
                id="new-admin-nom"
                value={newAdminNom}
                onChange={(event) => setNewAdminNom(event.target.value)}
                disabled={isCreatingAdmin}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-admin-email">Email</Label>
              <Input
                id="new-admin-email"
                type="email"
                value={newAdminEmail}
                onChange={(event) => setNewAdminEmail(event.target.value)}
                disabled={isCreatingAdmin}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="new-admin-password">Mot de passe</Label>
              <Input
                id="new-admin-password"
                type="password"
                value={newAdminPassword}
                onChange={(event) => setNewAdminPassword(event.target.value)}
                disabled={isCreatingAdmin}
              />
              <p className="text-xs text-muted-foreground">Au moins 8 caractères.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewAdminClubId(null)} disabled={isCreatingAdmin}>
              Annuler
            </Button>
            <Button
              onClick={handleCreateAdmin}
              disabled={
                isCreatingAdmin
                || !newAdminNom.trim()
                || !newAdminEmail.trim()
                || newAdminPassword.length < 8
              }
            >
              {isCreatingAdmin ? 'Création...' : 'Créer'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
