/**
 * Classification des données et décision de chiffrement (issue #24).
 * Ce n’est pas un avis juridique (#12 / #40).
 */
export type DataSensitivity = 'secret' | 'capability' | 'coordinate' | 'content' | 'blob' | 'telemetry' | 'backup';

export interface DataClassEntry {
  id: string;
  category: DataSensitivity;
  examples: string;
  atRest: string;
  notes: string;
}

export const DATA_CLASSIFICATION: readonly DataClassEntry[] = [
  {
    id: 'app-encryption-key',
    category: 'secret',
    examples: 'APP_ENCRYPTION_KEY, APP_ENCRYPTION_PREVIOUS_KEYS, BACKUP_ENCRYPTION_KEY, CRON_SECRET, DB passwords',
    atRest: 'Gestionnaire équivalent : fichier deploy/.env hors dépôt, hors image, hors dump. Jamais loggé.',
    notes: 'Anneau de clés applicatif (key-id). BACKUP_ENCRYPTION_KEY distincte de APP_ENCRYPTION_KEY.',
  },
  {
    id: 'session-tokens',
    category: 'capability',
    examples: 'user_sessions.id, platform_sessions.id',
    atRest: 'Hachage : ticket #29. Ici : secrets de session, pas de chiffrement colonne dans ce ticket.',
    notes: 'Coordonner #29.',
  },
  {
    id: 'capability-urls',
    category: 'capability',
    examples: 'invitations, password-reset, public share, iCal',
    atRest: 'Jetons d’invitation / share déjà hashés. iCal : #13.',
    notes: 'Pas de re-chiffrement : un hash suffit à la révocation.',
  },
  {
    id: 'coordinates',
    category: 'coordinate',
    examples: 'users.email, téléphone, nom',
    atRest: 'Chiffrement volume / accès DB (#36). Pas de chiffrement colonne (recherche / unicité).',
    notes: 'Contrôle d’accès tenant + TLS en transit.',
  },
  {
    id: 'chat-smtp',
    category: 'content',
    examples: 'chat_messages.content, club_tenants.smtpPasswordEncrypted',
    atRest: 'AES-256-GCM enveloppe enc:v2:<keyId>:… (lecture enc:v1 conservée).',
    notes: 'Rotation via APP_ENCRYPTION_PREVIOUS_KEYS + scripts/rotate-encryption-keys.ts.',
  },
  {
    id: 'reports',
    category: 'content',
    examples: 'rapports post-événement',
    atRest: 'Accès restreint (#28). Chiffrement colonne non retenu (volume #36).',
    notes: 'Texte de rapport dans les audits : #8.',
  },
  {
    id: 'attachments',
    category: 'blob',
    examples: 'chat_attachments.content, planning_attachments.content',
    atRest: 'Inspection #23. Chiffrement BLOB reporté au chiffrement volume (#36) : taille / quota / streaming.',
    notes: 'Si le volume n’est pas chiffré, le dump AEAD couvre une copie hors ligne.',
  },
  {
    id: 'push',
    category: 'capability',
    examples: 'endpoint, p256dh, auth_secret, user_agent',
    atRest: 'endpoint_hash SHA-256. Secrets push en clair colonne ; chiffrement volume #36.',
    notes: 'user_agent : minimiser (#29 métadonnées).',
  },
  {
    id: 'audit',
    category: 'telemetry',
    examples: 'match_audit_log, logs applicatifs',
    atRest: 'Logs structurés expurgés (#31). Pas de secret dans l’audit.',
    notes: 'Rétention #9 / #20.',
  },
  {
    id: 'backups',
    category: 'backup',
    examples: 'deploy/backups/clubika-*.sql.gz.enc',
    atRest: 'AES-256-GCM (BACKUP_ENCRYPTION_KEY) + SHA-256. Clé hors dump.',
    notes: 'Rétention BACKUP_KEEP_DAYS (défaut 14). Restauration : restore-mariadb.sh --verify.',
  },
] as const;

export function classificationIds(): string[] {
  return DATA_CLASSIFICATION.map((entry) => entry.id);
}
