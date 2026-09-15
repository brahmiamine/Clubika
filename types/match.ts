export type PersonType = 'officiel' | 'encadrant' | 'accompagnateur';
export type AssignmentStatus = 'pending' | 'accepted' | 'declined';
export type AttendanceStatus = 'unknown' | 'present' | 'excused' | 'absent' | 'replaced';
export type ReminderStage = 'awaiting-48h' | '72h' | '24h';
export type PlanningPublicationStatus = 'draft' | 'published' | 'modified' | 'cancelled';
export type ScraperSourceStatus = 'active' | 'missing';
export type DeclineReason = 'work' | 'travel' | 'other_assignment' | 'personal' | 'other';

export interface PlanningPublicationMeta {
  planningRevision?: number;
  planningStatus?: PlanningPublicationStatus;
  publishedAt?: string;
  publishedByUserId?: number;
  modifiedAfterPublishAt?: string;
  cancelledAt?: string | null;
  cancelledByUserId?: number;
  cancellationReason?: string | null;
}

export interface AssignmentContact {
  nom: string;
  numero: string;
  personId?: number;
  personType?: PersonType;
  status?: AssignmentStatus;
  assignedAt?: string;
  respondedAt?: string;
  declineReason?: DeclineReason;
  declineComment?: string;
  attendanceStatus?: AttendanceStatus;
  attendanceUpdatedAt?: string;
  remindersSent?: ReminderStage[];
  lastReminderAt?: string;
  reminderCount?: number;
}

export interface MatchDetails {
  stadium: string;
  dateTime: string;
  competition: string;
  address: string;
  terrainType: string;
  itineraryLink: string;
  rawText: string;
}

export interface MatchStaff {
  referee: string;
  assistant1: string;
  assistant2: string;
  rawText: string;
}

export type MatchType = 'officiel' | 'amical' | 'entrainement' | 'plateau';

export interface OfficialMatchAdminOverride {
  date?: string;
  time?: string;
  durationMinutes?: number;
  localTeam?: string;
  awayTeam?: string;
  competition?: string;
  categorie?: string;
  venue?: 'domicile' | 'extérieur';
  horaireRendezVous?: string;
  details?: Partial<Pick<MatchDetails, 'stadium' | 'address' | 'terrainType' | 'itineraryLink'>> | null;
  staff?: Partial<Pick<MatchStaff, 'referee' | 'assistant1' | 'assistant2'>> | null;
}

export type LicensedImportProvider = 'manual' | 'csv' | 'licensed-api';

export interface ImportProvenance {
  provider: LicensedImportProvider | 'sportcorico-api' | 'unknown-external';
  providerId?: string;
  licenseRef?: string;
  importedAt?: string;
  importedByUserId?: number;
  rightsAttested?: boolean;
  quarantined?: boolean;
}

export interface Match extends PlanningPublicationMeta {
  id?: string;
  type?: MatchType;
  date: string;
  competition: string;
  categorie?: string;
  localTeam: string;
  awayTeam: string;
  venue: 'domicile' | 'extérieur';
  localTeamLogo?: string;
  awayTeamLogo?: string;
  time: string;
  horaireRendezVous: string;
  durationMinutes?: number;
  seriesId?: string;
  url?: string;
  rawText?: string;
  details?: MatchDetails | null;
  staff?: MatchStaff | null;
  sourceStatus?: ScraperSourceStatus;
  sourceLastSeenAt?: string;
  sourceMissingSince?: string;
  sourceMissingObservations?: number;
  /** Identifiant/slug actuellement publié par la source externe. */
  sourceMatchId?: string;
  /** Historique borné des identifiants externes déjà observés pour ce match interne. */
  sourceMatchIds?: string[];
  /** Renseigné lorsqu'un nouvel identifiant source a été rattaché automatiquement au match existant. */
  sourceIdentityReconciledAt?: string;
  /** Score (0-100) de la dernière réconciliation automatique d'identité source. */
  sourceIdentityConfidence?: number;
  /** Provenance d'import (issue #5). Absent sur l'historique SportCorico non encore quarantiné. */
  importProvenance?: ImportProvenance;
}

export interface ClubInfo {
  name: string;
  description: string;
  logo: string;
}

export interface MatchesData {
  club: ClubInfo;
  url: string;
  scrapedAt: string;
  matches: Record<string, Match[]>;
}

export interface MatchesAmicauxData {
  matches: Record<string, Match[]>;
}

export interface Entrainement extends PlanningPublicationMeta {
  id: string;
  type: 'entrainement';
  date: string;
  time: string;
  lieu: string;
  categorie?: string;
  durationMinutes?: number;
  seriesId?: string;
  encadrants?: AssignmentContact[];
  encadrant?: {
    nom: string;
    prenom: string;
  };
}

export interface EntrainementsData {
  entrainements: Record<string, Entrainement[]>;
}

export interface Plateau extends PlanningPublicationMeta {
  id: string;
  type: 'plateau';
  date: string;
  time: string;
  lieu: string;
  categories?: string[];
  durationMinutes?: number;
  seriesId?: string;
  encadrants?: AssignmentContact[];
  encadrant?: {
    nom: string;
    prenom: string;
  };
}

export interface PlateauxData {
  plateaux: Record<string, Plateau[]>;
}
