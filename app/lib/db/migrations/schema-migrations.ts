import { readMigrationLogicFile, type SchemaMigration } from './runner';
import { convertEventPrimaryKeysToTenantScoped } from './event-primary-keys';
import { backfillAuditLogClubId } from './audit-log-tenant';
import { backfillClubAccessRoles } from './club-access-roles';
import { backfillUnclaimedProfiles } from './unclaimed-profiles';
import { hashExistingInvitationTokens } from './invitation-token-hash';
import { scopeUserEmailUniquenessToClub } from './user-email-club-scoped';
import { hardenTypeormEntityTables, TYPEORM_ENTITY_TABLE_STATEMENTS } from './typeorm-entity-tables';
import { enforceCriticalReferentialIntegrity } from './referential-integrity';
import { enforceDataUniques } from './data-uniques';
import { enforcePhase2ReferentialIntegrity } from './referential-integrity-phase2';

/**
 * Registre des migrations de schéma versionnées (issue #129).
 *
 * Les migrations 0001 à 0007 reprennent à l'identique le DDL qui était auparavant
 * exécuté au runtime par les modules métier (`CREATE TABLE IF NOT EXISTS` au premier
 * appel). Toute évolution future du schéma hors entités TypeORM doit ajouter une
 * nouvelle migration ici — jamais modifier une migration déjà publiée.
 *
 * La migration 0008 (issue #125) convertit les clés primaires des tables
 * d'événements en clés composites tenant-scoped ; elle est exécutée par le runner
 * — avant `synchronize` — pour vérifier les collisions avant toute modification.
 *
 * La migration 0009 (issue #126) ajoute la colonne tenant `clubId` (nullable) à
 * `match_audit_log` et la remplit par jointure sur `users`, avec repli signalé
 * sur le club par défaut pour les lignes sans auteur résolu ; `synchronize`
 * durcit ensuite la colonne en NOT NULL et crée l'index tenant.
 *
 * La migration 0010 (issue #209) sépare le rôle d'accès au club (`accessRole`) des
 * fonctions opérationnelles (`planningFunctions`) sur `users` et `invitations` : les
 * colonnes sont ajoutées nullables et remplies depuis l'ancien tableau cumulatif
 * `roles`, que `synchronize` supprime ensuite.
 *
 * La migration 0017 (issue #266) fait passer l'unicité de `users.email` de globale
 * à `(clubId, email)` : un même dirigeant peut désormais avoir un compte dans
 * plusieurs clubs de l'instance. L'ancien index unique global — porté par une
 * table d'entité TypeORM, donc géré par `synchronize` en temps normal — est
 * retrouvé par introspection et supprimé ici, AVANT `synchronize`, pour ne jamais
 * laisser cohabiter les deux contraintes.
 *
 * La migration 0018 (issue #283) crée les tables d'entités TypeORM et durcit le
 * schéma que `synchronize` appliquait jusqu'ici après le runner. Le démarrage
 * applicatif ne doit plus appeler `synchronize()` en production.
 *
 * La migration 0019 (issue #350) nettoie les orphelins sur `user_sessions`,
 * `notifications` et `chat_participants`, puis pose des FOREIGN KEY vers `users`
 * La migration 0020 (issue #352) crée `chat_rate_limit_events` pour partager les
 * fenêtres glissantes Socket.IO entre pods — voir socket-rate-limit.ts.
 *
 * La migration 0021 (issue #386) ajoute les contraintes UNIQUE sur sourceMatchId et
 * invitations pending par email.
 *
 * La migration 0022 (issue #385) étend l'intégrité référentielle phase 2.
 *
 * La migration 0023 ajoute les colonnes de réponse, transfert et modération sur
 * `chat_messages`.
 *
 * La migration 0024 crée `chat_message_reactions` (réactions emoji sur les messages).
 *
 * La migration 0025 stocke les rapports CSP sanitizés (hôtes + directive, jamais
 * d'URI complète — issue #35). Rétention 7 jours, purge à l'écriture.
 *
 * Rappel : toute évolution future d'une entité TypeORM (`EntitySchema` dans
 * `app/lib/db/schemas.ts`) doit ajouter une nouvelle migration ici — jamais
 * modifier une migration déjà publiée, jamais réactiver `synchronize` au boot.
 */
export const schemaMigrations: readonly SchemaMigration[] = [
  {
    version: '0001',
    name: 'planning_records_et_attachments',
    statements: [
      `CREATE TABLE IF NOT EXISTS planning_records (
        id VARCHAR(191) NOT NULL PRIMARY KEY,
        kind VARCHAR(64) NOT NULL,
        event_type VARCHAR(32) NULL,
        event_id VARCHAR(191) NULL,
        owner_user_id INT NULL,
        person_type VARCHAR(32) NULL,
        person_id INT NULL,
        payload LONGTEXT NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        INDEX idx_planning_records_kind (kind),
        INDEX idx_planning_records_event (event_type, event_id, kind),
        INDEX idx_planning_records_owner (owner_user_id, kind),
        INDEX idx_planning_records_person (person_type, person_id, kind)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS planning_attachments (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        event_type VARCHAR(32) NOT NULL,
        event_id VARCHAR(191) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(128) NOT NULL,
        size_bytes INT UNSIGNED NOT NULL,
        content LONGBLOB NOT NULL,
        uploaded_by_user_id INT NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_planning_attachments_event (event_type, event_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Colonnes tenant ajoutées après coup à l'époque : rejouées ici pour les
      // bases héritées d'avant leur introduction.
      `ALTER TABLE planning_records ADD COLUMN IF NOT EXISTS club_id VARCHAR(64) NOT NULL DEFAULT 'afp' AFTER id`,
      `ALTER TABLE planning_attachments ADD COLUMN IF NOT EXISTS club_id VARCHAR(64) NOT NULL DEFAULT 'afp' AFTER id`,
      `CREATE INDEX IF NOT EXISTS idx_planning_records_club ON planning_records (club_id, kind)`,
      `CREATE INDEX IF NOT EXISTS idx_planning_attachments_club ON planning_attachments (club_id, event_type, event_id)`,
    ],
    // Note : l'ancien `ensurePlanningSupportTables` réattribuait toutes les lignes
    // au club `APP_CLUB_ID` lors de l'ajout initial de la colonne. Ce rattrapage a
    // déjà été exécuté sur toute base ayant démarré l'application depuis lors ; il
    // n'est pas rejoué ici (une base existante possède déjà la colonne, une base
    // neuve n'a aucune ligne à rattraper).
  },
  {
    version: '0002',
    name: 'planning_event_state',
    statements: [
      `CREATE TABLE IF NOT EXISTS planning_event_state (
        club_id VARCHAR(64) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        event_id VARCHAR(191) NOT NULL,
        archived_at DATETIME(6) NULL,
        archived_by_user_id INT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (club_id, event_type, event_id),
        INDEX idx_planning_event_state_archived (club_id, archived_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0003',
    name: 'push_subscriptions',
    statements: [
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        endpoint_hash CHAR(64) NOT NULL UNIQUE,
        endpoint TEXT NOT NULL,
        p256dh TEXT NULL,
        auth_secret TEXT NULL,
        user_agent VARCHAR(512) NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        INDEX idx_push_subscriptions_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0004',
    name: 'planning_notification_outbox',
    statements: [
      `CREATE TABLE IF NOT EXISTS planning_notification_outbox (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        user_id INT NOT NULL,
        channel VARCHAR(16) NOT NULL,
        notification_type VARCHAR(64) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        event_type VARCHAR(32) NULL,
        event_id VARCHAR(191) NULL,
        urgency VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        next_attempt_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        last_error TEXT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        sent_at DATETIME(6) NULL,
        INDEX idx_notification_outbox_due (status, next_attempt_at),
        INDEX idx_notification_outbox_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0005',
    name: 'chat_attachments',
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_attachments (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        club_id VARCHAR(64) NOT NULL,
        room_id VARCHAR(64) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        mime_type VARCHAR(128) NOT NULL,
        size_bytes INT UNSIGNED NOT NULL,
        content LONGBLOB NOT NULL,
        uploaded_by_user_id INT NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_chat_attachments_room (room_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0006',
    name: 'scraper_sync_runs',
    statements: [
      `CREATE TABLE IF NOT EXISTS scraper_sync_runs (
        id VARCHAR(64) NOT NULL PRIMARY KEY,
        club_id VARCHAR(64) NOT NULL DEFAULT 'afp',
        status VARCHAR(16) NOT NULL,
        started_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        finished_at DATETIME(6) NULL,
        active_count INT NULL,
        created_count INT NULL,
        updated_count INT NULL,
        missing_count INT NULL,
        error_message TEXT NULL,
        INDEX idx_scraper_sync_runs_started (started_at),
        INDEX idx_scraper_sync_runs_status (status, started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      // Colonne tenant ajoutée après coup à l'époque : rejouée pour les bases héritées.
      `ALTER TABLE scraper_sync_runs ADD COLUMN IF NOT EXISTS club_id VARCHAR(64) NOT NULL DEFAULT 'afp'`,
      `CREATE INDEX IF NOT EXISTS idx_scraper_sync_runs_club ON scraper_sync_runs (club_id, started_at)`,
    ],
  },
  {
    version: '0007',
    name: 'planning_assignment_state',
    statements: [
      `CREATE TABLE IF NOT EXISTS planning_assignment_state (
        club_id VARCHAR(64) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        event_id VARCHAR(191) NOT NULL,
        role VARCHAR(32) NOT NULL,
        person_key VARCHAR(255) NOT NULL,
        person_type VARCHAR(32) NULL,
        person_id INT NULL,
        person_name VARCHAR(255) NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (club_id, event_type, event_id, role, person_key),
        INDEX idx_assignment_state_person (club_id, person_type, person_id),
        INDEX idx_assignment_state_event (club_id, event_type, event_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0008',
    name: 'cles_primaires_evenements_tenant_scoped',
    // Conversion conditionnelle (vérification des collisions avant ALTER) :
    // implémentée dans `up`, sans statement SQL statique — voir event-primary-keys.ts.
    statements: [],
    logic: readMigrationLogicFile('event-primary-keys.ts'),
    up: convertEventPrimaryKeysToTenantScoped,
  },
  {
    version: '0009',
    name: 'audit_log_tenant_scoped',
    // La colonne est ajoutée nullable (une NOT NULL ne peut pas être créée sur
    // une table remplie) puis remplie par `up` ; `synchronize` la durcit en
    // NOT NULL et crée l'index tenant — voir audit-log-tenant.ts.
    statements: [
      'ALTER TABLE IF EXISTS match_audit_log ADD COLUMN IF NOT EXISTS clubId VARCHAR(255) NULL AFTER id',
    ],
    logic: readMigrationLogicFile('audit-log-tenant.ts'),
    up: async (db) => {
      await backfillAuditLogClubId(db);
    },
  },
  {
    version: '0010',
    name: 'roles_acces_club_et_fonctions_planning',
    // Colonnes ajoutées nullables sur des tables remplies, puis backfill depuis
    // l'ancien tableau `roles` ; `synchronize` les durcit et retire `roles`
    // (users) / `role` (invitations) — voir club-access-roles.ts.
    statements: [
      'ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS accessRole VARCHAR(255) NULL AFTER nom',
      'ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS planningFunctions TEXT NULL AFTER accessRole',
      'ALTER TABLE IF EXISTS invitations ADD COLUMN IF NOT EXISTS accessRole VARCHAR(255) NULL AFTER email',
      'ALTER TABLE IF EXISTS invitations ADD COLUMN IF NOT EXISTS planningFunctions TEXT NULL AFTER accessRole',
    ],
    logic: readMigrationLogicFile('club-access-roles.ts'),
    up: async (db) => {
      await backfillClubAccessRoles(db);
    },
  },
  {
    version: '0011',
    name: 'chat_attachment_quota_indexes',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_chat_attachments_user_quota
       ON chat_attachments (club_id, uploaded_by_user_id, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_chat_attachments_club_quota
       ON chat_attachments (club_id, created_at)`,
    ],
  },
  {
    version: '0012',
    name: 'profils_dirigeants_sans_acces',
    // Colonne ajoutée nullable (table potentiellement remplie) puis backfill :
    // les comptes existants avec un email réel sont marqués activés, les profils
    // techniques @sans-acces.local restent non réclamés (issue #204).
    statements: [
      'ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS claimedAt DATETIME NULL AFTER active',
    ],
    logic: readMigrationLogicFile('unclaimed-profiles.ts'),
    up: async (db) => {
      await backfillUnclaimedProfiles(db);
    },
  },
  {
    version: '0013',
    name: 'invitations_token_hash',
    // `invitations` est une table portée par une entité TypeORM (créée par
    // `synchronize`, après ce registre) : rien à réhacher sur une base neuve, d'où
    // l'absence de `statements` — voir invitation-token-hash.ts.
    statements: [],
    logic: readMigrationLogicFile('invitation-token-hash.ts'),
    up: async (db) => {
      await hashExistingInvitationTokens(db);
    },
  },
  {
    version: '0014',
    name: 'login_rate_limits',
    // Compteurs de limitation de débit à la connexion (issue #274), en base pour rester
    // efficaces sur plusieurs instances de l'application (un compteur en mémoire par
    // instance serait contournable en répartissant les tentatives). `bucket_key` porte
    // déjà une empreinte SHA-256 (IP ou identité, jamais en clair) — voir login-rate-limit.ts.
    statements: [
      `CREATE TABLE IF NOT EXISTS login_rate_limits (
        bucket_key VARCHAR(96) NOT NULL PRIMARY KEY,
        attempts INT UNSIGNED NOT NULL DEFAULT 0,
        first_attempt_at DATETIME(6) NOT NULL,
        last_attempt_at DATETIME(6) NOT NULL,
        locked_until DATETIME(6) NULL,
        INDEX idx_login_rate_limits_locked (locked_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0015',
    name: 'planning_records_token_hash',
    // Résolution d'un lien de partage public par jeton (issue #277) : jusqu'ici un
    // balayage des 1000 enregistrements `public-share` les plus récents, tous clubs
    // confondus — un lien plus ancien devenait irrésolvable une fois 1000 liens plus
    // récents émis. La colonne existait déjà en pratique dans `payload.tokenHash` (déjà
    // hachée, jamais le jeton brut) : ce backfill la recopie dans une colonne indexée
    // dédiée, sans avoir besoin de retrouver un jeton brut jamais stocké.
    statements: [
      'ALTER TABLE planning_records ADD COLUMN IF NOT EXISTS token_hash CHAR(64) NULL AFTER person_id',
      `UPDATE planning_records SET token_hash = JSON_UNQUOTE(JSON_EXTRACT(payload, '$.tokenHash'))
       WHERE kind = 'public-share' AND token_hash IS NULL`,
      'CREATE INDEX IF NOT EXISTS idx_planning_records_token_hash ON planning_records (token_hash)',
    ],
  },
  {
    version: '0016',
    name: 'planning_notification_outbox_idempotency',
    // Empreinte d'idempotence par intention de notification (issue #276) : deux
    // publications concurrentes parties du même état publié précédent calculent la
    // même clé pour un même changement — `enqueueNotificationDelivery` s'appuie sur
    // l'index unique ci-dessous pour faire converger ces appels sur une seule ligne
    // d'outbox plutôt que de doubler la notification. NULL pour tout usage hors
    // publication (non concerné) : un index unique MySQL/MariaDB autorise plusieurs
    // valeurs NULL.
    statements: [
      'ALTER TABLE planning_notification_outbox ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255) NULL AFTER urgency',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_outbox_idempotency ON planning_notification_outbox (idempotency_key)',
    ],
  },
  {
    version: '0017',
    name: 'email_unique_par_club',
    // `users` est une table portée par une entité TypeORM : l'ancien index unique
    // global sur `email` porte un nom généré par TypeORM, retrouvé par
    // introspection plutôt que supposé ; pas de `statements` statique — voir
    // user-email-club-scoped.ts (issue #266).
    statements: [],
    logic: readMigrationLogicFile('user-email-club-scoped.ts'),
    up: async (db) => {
      await scopeUserEmailUniquenessToClub(db);
    },
  },
  {
    version: '0018',
    name: 'tables_entites_typeorm',
    statements: TYPEORM_ENTITY_TABLE_STATEMENTS,
    logic: readMigrationLogicFile('typeorm-entity-tables.ts'),
    up: async (db) => {
      await hardenTypeormEntityTables(db);
    },
  },
  {
    version: '0019',
    name: 'integrite_referentielle_utilisateurs',
    statements: [],
    logic: readMigrationLogicFile('referential-integrity.ts'),
    up: async (db) => {
      await enforceCriticalReferentialIntegrity(db);
    },
  },
  {
    version: '0020',
    name: 'chat_rate_limit_events',
    // Événements de fenêtre glissante pour les limites Socket.IO partagées entre
    // instances (issue #352) — voir app/lib/chat/socket-rate-limit.ts.
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_rate_limit_events (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        bucket_key VARCHAR(128) NOT NULL,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        INDEX idx_chat_rate_limit_bucket_time (bucket_key, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0021',
    name: 'contraintes_uniques_source_match_et_invitations',
    statements: [
      'ALTER TABLE matches_officiels ADD COLUMN IF NOT EXISTS sourceMatchId VARCHAR(255) NULL AFTER time',
      'ALTER TABLE invitations ADD COLUMN IF NOT EXISTS pendingEmailKey VARCHAR(320) NULL AFTER email',
    ],
    logic: readMigrationLogicFile('data-uniques.ts'),
    up: async (db) => {
      await enforceDataUniques(db);
    },
  },
  {
    version: '0022',
    name: 'integrite_referentielle_phase2',
    statements: [],
    logic: readMigrationLogicFile('referential-integrity-phase2.ts'),
    up: async (db) => {
      await enforcePhase2ReferentialIntegrity(db);
    },
  },
  {
    version: '0023',
    name: 'colonnes_chat_messages_reponses_moderation',
    statements: [
      'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS replyToMessageId VARCHAR(255) NULL AFTER attachmentSize',
      'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwardedFromName VARCHAR(255) NULL AFTER replyToMessageId',
      'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS forwardedFromUserId INT NULL AFTER forwardedFromName',
      'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deletedAt DATETIME(6) NULL AFTER createdAt',
      'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS deletedByUserId INT NULL AFTER deletedAt',
    ],
  },
  {
    version: '0024',
    name: 'chat_message_reactions',
    statements: [
      `CREATE TABLE IF NOT EXISTS chat_message_reactions (
        messageId VARCHAR(255) NOT NULL,
        userId INT NOT NULL,
        emoji VARCHAR(32) NOT NULL,
        createdAt DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (messageId, userId, emoji),
        INDEX idx_chat_message_reactions_message (messageId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
  {
    version: '0025',
    name: 'csp_reports_sanitized',
    statements: [
      `CREATE TABLE IF NOT EXISTS csp_reports (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        document_host VARCHAR(255) NOT NULL,
        blocked_host VARCHAR(255) NULL,
        violated_directive VARCHAR(64) NOT NULL,
        disposition VARCHAR(16) NOT NULL,
        PRIMARY KEY (id),
        INDEX idx_csp_reports_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    ],
  },
];
