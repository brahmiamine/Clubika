import type { DataSource } from 'typeorm';
import { countQuery, tableExists } from './sql';

export type TenantStoreScope =
  | 'clubId'
  | 'club_id'
  | 'via_users'
  | 'via_rooms'
  | 'tombstone'
  | 'documented';

export interface TenantStoreSpec {
  id: string;
  table: string | null;
  label: string;
  scope: TenantStoreScope;
  blob?: boolean;
  capability?: boolean;
  /** Conservé après purge : journal technique sans contenu personnel. */
  keepAfterPurge?: boolean;
  /** Secrets exclus de la restitution. */
  secret?: boolean;
  documentedOnly?: boolean;
}

/**
 * Inventaire machine-readable de tout stockage rattachable à un tenant.
 * Les tables plateforme (`platform_admins`, `platform_sessions`, `app_meta`)
 * sont volontairement absentes : elles n'appartiennent pas au club.
 */
export const TENANT_STORES: readonly TenantStoreSpec[] = [
  { id: 'planning_attachments', table: 'planning_attachments', label: 'Pièces jointes planning (BLOB)', scope: 'club_id', blob: true },
  { id: 'chat_attachments', table: 'chat_attachments', label: 'Pièces jointes chat (BLOB)', scope: 'club_id', blob: true },
  { id: 'chat_message_reactions', table: 'chat_message_reactions', label: 'Réactions chat', scope: 'via_rooms' },
  { id: 'chat_read_states', table: 'chat_read_states', label: 'États de lecture chat', scope: 'via_rooms' },
  { id: 'chat_messages', table: 'chat_messages', label: 'Messages chat', scope: 'via_rooms' },
  { id: 'chat_participants', table: 'chat_participants', label: 'Participants chat', scope: 'via_rooms' },
  { id: 'chat_rooms', table: 'chat_rooms', label: 'Salons chat', scope: 'clubId' },
  { id: 'planning_assignment_state', table: 'planning_assignment_state', label: 'États d’affectation', scope: 'club_id' },
  { id: 'planning_event_state', table: 'planning_event_state', label: 'États d’événements planning', scope: 'club_id' },
  { id: 'planning_records', table: 'planning_records', label: 'Enregistrements planning (partages, rapports, préférences)', scope: 'club_id' },
  { id: 'scraper_sync_runs', table: 'scraper_sync_runs', label: 'Journal de collecte calendrier', scope: 'club_id' },
  { id: 'match_audit_log', table: 'match_audit_log', label: 'Journal d’audit matchs', scope: 'clubId' },
  { id: 'matches_extras', table: 'matches_extras', label: 'Compléments de matchs', scope: 'clubId' },
  { id: 'matches_officiels', table: 'matches_officiels', label: 'Matchs officiels', scope: 'clubId' },
  { id: 'matches_amicaux', table: 'matches_amicaux', label: 'Matchs amicaux', scope: 'clubId' },
  { id: 'entrainements', table: 'entrainements', label: 'Entraînements', scope: 'clubId' },
  { id: 'plateaux', table: 'plateaux', label: 'Plateaux', scope: 'clubId' },
  { id: 'categories', table: 'categories', label: 'Catégories', scope: 'clubId' },
  { id: 'stades', table: 'stades', label: 'Stades', scope: 'clubId' },
  { id: 'clubs', table: 'clubs', label: 'Clubs adverses / logos', scope: 'clubId' },
  { id: 'invitations', table: 'invitations', label: 'Invitations (jeton hashé)', scope: 'clubId', capability: true },
  { id: 'password_reset_tokens', table: 'password_reset_tokens', label: 'Jetons de réinitialisation', scope: 'via_users', secret: true, capability: true },
  { id: 'push_subscriptions', table: 'push_subscriptions', label: 'Abonnements Web Push', scope: 'via_users', secret: true, capability: true },
  { id: 'planning_notification_outbox', table: 'planning_notification_outbox', label: 'File de notifications', scope: 'via_users' },
  { id: 'notifications', table: 'notifications', label: 'Notifications in-app', scope: 'via_users' },
  { id: 'user_sessions', table: 'user_sessions', label: 'Sessions club', scope: 'via_users', secret: true, capability: true },
  { id: 'users', table: 'users', label: 'Comptes du club (iCal, e-mail, téléphone)', scope: 'clubId', capability: true },
  { id: 'tenant_offboarding_exports', table: 'tenant_offboarding_exports', label: 'Jetons d’export de restitution', scope: 'clubId', secret: true, capability: true },
  { id: 'tenant_processor_instructions', table: 'tenant_processor_instructions', label: 'Instructions sous-traitants', scope: 'clubId', keepAfterPurge: true },
  { id: 'tenant_offboarding_events', table: 'tenant_offboarding_events', label: 'Journal technique d’offboarding', scope: 'clubId', keepAfterPurge: true },
  { id: 'tenant_deletion_certificates', table: 'tenant_deletion_certificates', label: 'Certificats de suppression', scope: 'clubId', keepAfterPurge: true },
  { id: 'club_tenants', table: 'club_tenants', label: 'Fiche tenant (tombstone après purge)', scope: 'tombstone' },
  {
    id: 'login_rate_limits',
    table: 'login_rate_limits',
    label: 'Limites de connexion (clé hashée, non recherchable)',
    scope: 'documented',
    documentedOnly: true,
  },
  {
    id: 'chat_rate_limit_events',
    table: 'chat_rate_limit_events',
    label: 'Fenêtres de débit chat (clé hashée, TTL)',
    scope: 'documented',
    documentedOnly: true,
  },
  {
    id: 'platform_admins',
    table: 'platform_admins',
    label: 'Administrateurs plateforme (hors tenant)',
    scope: 'documented',
    documentedOnly: true,
  },
  {
    id: 'backups',
    table: null,
    label: 'Sauvegardes MariaDB (rotation documentée, pas de remise en prod des tenants purgés)',
    scope: 'documented',
    documentedOnly: true,
  },
];

export interface StoreCount {
  id: string;
  table: string | null;
  label: string;
  blob?: boolean;
  capability?: boolean;
  keepAfterPurge?: boolean;
  documentedOnly?: boolean;
  scanned: number | null;
}

const ROOM_COUNT_SQL: Record<string, string> = {
  chat_message_reactions: `SELECT COUNT(*) AS n FROM chat_message_reactions x
    INNER JOIN chat_messages m ON m.id = x.messageId
    INNER JOIN chat_rooms r ON r.id = m.roomId WHERE r.clubId = ?`,
  chat_read_states: `SELECT COUNT(*) AS n FROM chat_read_states x
    INNER JOIN chat_rooms r ON r.id = x.roomId WHERE r.clubId = ?`,
  chat_messages: `SELECT COUNT(*) AS n FROM chat_messages x
    INNER JOIN chat_rooms r ON r.id = x.roomId WHERE r.clubId = ?`,
  chat_participants: `SELECT COUNT(*) AS n FROM chat_participants x
    INNER JOIN chat_rooms r ON r.id = x.roomId WHERE r.clubId = ?`,
};

const USER_COUNT_SQL: Record<string, string> = {
  password_reset_tokens: `SELECT COUNT(*) AS n FROM password_reset_tokens x
    INNER JOIN users u ON u.id = x.userId WHERE u.clubId = ?`,
  push_subscriptions: `SELECT COUNT(*) AS n FROM push_subscriptions x
    INNER JOIN users u ON u.id = x.user_id WHERE u.clubId = ?`,
  planning_notification_outbox: `SELECT COUNT(*) AS n FROM planning_notification_outbox x
    INNER JOIN users u ON u.id = x.user_id WHERE u.clubId = ?`,
  notifications: `SELECT COUNT(*) AS n FROM notifications x
    INNER JOIN users u ON u.id = x.userId WHERE u.clubId = ?`,
  user_sessions: `SELECT COUNT(*) AS n FROM user_sessions x
    INNER JOIN users u ON u.id = x.userId WHERE u.clubId = ?`,
};

export async function countStore(db: DataSource, store: TenantStoreSpec, clubId: string): Promise<number | null> {
  if (store.documentedOnly || !store.table) return null;
  if (!(await tableExists(db, store.table))) return 0;
  if (store.scope === 'tombstone') {
    return countQuery(db, 'SELECT COUNT(*) AS n FROM club_tenants WHERE id = ?', [clubId]);
  }
  if (store.scope === 'club_id') {
    return countQuery(db, `SELECT COUNT(*) AS n FROM ${store.table} WHERE club_id = ?`, [clubId]);
  }
  if (store.scope === 'clubId') {
    const column = store.table === 'club_tenants' ? 'id' : 'clubId';
    return countQuery(db, `SELECT COUNT(*) AS n FROM ${store.table} WHERE ${column} = ?`, [clubId]);
  }
  if (store.scope === 'via_rooms') {
    const sql = ROOM_COUNT_SQL[store.id];
    return sql ? countQuery(db, sql, [clubId]) : 0;
  }
  if (store.scope === 'via_users') {
    const sql = USER_COUNT_SQL[store.id];
    return sql ? countQuery(db, sql, [clubId]) : 0;
  }
  return null;
}

export async function inventoryClub(db: DataSource, clubId: string): Promise<StoreCount[]> {
  const rows: StoreCount[] = [];
  for (const store of TENANT_STORES) {
    rows.push({
      id: store.id,
      table: store.table,
      label: store.label,
      blob: store.blob,
      capability: store.capability,
      keepAfterPurge: store.keepAfterPurge,
      documentedOnly: store.documentedOnly,
      scanned: await countStore(db, store, clubId),
    });
  }
  return rows;
}

export function purgableStores(): TenantStoreSpec[] {
  return TENANT_STORES.filter((store) => !store.documentedOnly && !store.keepAfterPurge && store.scope !== 'tombstone');
}
