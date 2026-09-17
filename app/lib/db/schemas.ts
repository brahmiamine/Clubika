import { EntitySchema } from 'typeorm';
import { OfficielIndisponibilite } from '@/lib/utils/officiel-availability';

function defaultClubId(): string {
  return process.env.APP_CLUB_ID || 'afp';
}

export interface ClubEntity {
  id: number;
  clubId: string;
  nom: string;
  logo: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CategorieEntity {
  id: number;
  clubId: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface StadeEntity {
  id: number;
  clubId: string;
  nom: string;
  adresse: string | null;
  googleMapsUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchOfficialEntity {
  id: string;
  clubId: string;
  date: string;
  time: string;
  sourceMatchId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchAmicalEntity {
  id: string;
  clubId: string;
  date: string;
  time: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntrainementEntity {
  id: string;
  clubId: string;
  date: string;
  time: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlateauEntity {
  id: string;
  clubId: string;
  date: string;
  time: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchExtraEntity {
  matchId: string;
  clubId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface AppMetaEntity {
  key: string;
  value: string;
  updatedAt: Date;
}

export const ClubSchema = new EntitySchema<ClubEntity>({
  name: 'Club',
  tableName: 'clubs',
  indices: [{ name: 'uq_clubs_club_nom', columns: ['clubId', 'nom'], unique: true }],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    clubId: { type: String, default: defaultClubId() },
    nom: { type: String },
    logo: { type: String },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const CategorieSchema = new EntitySchema<CategorieEntity>({
  name: 'Categorie',
  tableName: 'categories',
  indices: [{ name: 'uq_categories_club_value', columns: ['clubId', 'value'], unique: true }],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    clubId: { type: String, default: defaultClubId() },
    value: { type: String },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const StadeSchema = new EntitySchema<StadeEntity>({
  name: 'Stade',
  tableName: 'stades',
  indices: [{ name: 'uq_stades_club_nom', columns: ['clubId', 'nom'], unique: true }],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    clubId: { type: String, default: defaultClubId() },
    nom: { type: String },
    adresse: { type: String, nullable: true },
    googleMapsUrl: { type: String },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const MatchOfficialSchema = new EntitySchema<MatchOfficialEntity>({
  name: 'MatchOfficial',
  tableName: 'matches_officiels',
  indices: [
    { name: 'idx_matches_officiels_date', columns: ['date'] },
  ],
  columns: {
    // Clé primaire composite tenant-scoped (issue #125) : clubId en première
    // colonne, les lectures du club courant sont ainsi couvertes par la PK
    // (l'ancien index idx_matches_officiels_club devient redondant).
    clubId: { type: String, primary: true, default: defaultClubId() },
    id: { type: String, primary: true },
    date: { type: String },
    time: { type: String, default: '' },
    sourceMatchId: { type: String, nullable: true },
    payload: { type: 'simple-json' },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const MatchAmicalSchema = new EntitySchema<MatchAmicalEntity>({
  name: 'MatchAmical',
  tableName: 'matches_amicaux',
  indices: [
    { name: 'idx_matches_amicaux_date', columns: ['date'] },
  ],
  columns: {
    // Clé primaire composite tenant-scoped (issue #125), cf. MatchOfficialSchema.
    clubId: { type: String, primary: true, default: defaultClubId() },
    id: { type: String, primary: true },
    date: { type: String },
    time: { type: String, default: '' },
    payload: { type: 'simple-json' },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const EntrainementSchema = new EntitySchema<EntrainementEntity>({
  name: 'Entrainement',
  tableName: 'entrainements',
  indices: [
    { name: 'idx_entrainements_date', columns: ['date'] },
  ],
  columns: {
    // Clé primaire composite tenant-scoped (issue #125), cf. MatchOfficialSchema.
    clubId: { type: String, primary: true, default: defaultClubId() },
    id: { type: String, primary: true },
    date: { type: String },
    time: { type: String, default: '' },
    payload: { type: 'simple-json' },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const PlateauSchema = new EntitySchema<PlateauEntity>({
  name: 'Plateau',
  tableName: 'plateaux',
  indices: [
    { name: 'idx_plateaux_date', columns: ['date'] },
  ],
  columns: {
    // Clé primaire composite tenant-scoped (issue #125), cf. MatchOfficialSchema.
    clubId: { type: String, primary: true, default: defaultClubId() },
    id: { type: String, primary: true },
    date: { type: String },
    time: { type: String, default: '' },
    payload: { type: 'simple-json' },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const MatchExtraSchema = new EntitySchema<MatchExtraEntity>({
  name: 'MatchExtra',
  tableName: 'matches_extras',
  columns: {
    // Clé primaire composite tenant-scoped (issue #125), cf. MatchOfficialSchema.
    clubId: { type: String, primary: true, default: defaultClubId() },
    matchId: { type: String, primary: true },
    payload: { type: 'simple-json' },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export const AppMetaSchema = new EntitySchema<AppMetaEntity>({
  name: 'AppMeta',
  tableName: 'app_meta',
  columns: {
    key: { type: String, primary: true },
    value: { type: 'text' },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export interface UserEntity {
  id: number;
  clubId: string;
  email: string;
  passwordHash: string;
  nom: string;
  /** Rôle d'accès au club : 'admin' ou 'dirigeant' (issue #209). */
  accessRole: string;
  /** Fonctions opérationnelles cumulables : 'arbitre_club', 'encadrant', 'accompagnateur'. */
  planningFunctions: string[];
  active: boolean;
  /**
   * Date d'activation du compte (issue #204). `null` = profil de dirigeant sans
   * accès, créé par un référentiel de fonction en attente d'invitation : il ne
   * peut pas se connecter et n'est pas présenté comme un compte actif.
   */
  claimedAt: Date | null;
  /**
   * Fermeture RGPD (issue #11) : date à laquelle l'identité a été remplacée par le
   * stub « Utilisateur supprimé ». `null` = compte non fermé.
   */
  closedAt: Date | null;
  /** Demande de fermeture initiée par le titulaire, en attente ou déjà traitée. */
  closureRequestedAt: Date | null;
  /** Utilisateur (admin ou soi-même) qui a exécuté la fermeture. */
  closedByUserId: number | null;
  telephone: string | null;
  indisponibilites: OfficielIndisponibilite[] | null;
  /**
   * Empreinte SHA-256 du jeton iCal personnel (issue #13), jamais le jeton brut
   * — voir `app/lib/planning/ical-token.ts`. `null` = pas de flux actif (jamais
   * généré, révoqué, ou compte fermé/désactivé).
   */
  icalTokenHash: string | null;
  /** Date de génération du jeton iCal actif ; `null` si aucun jeton actif. */
  icalTokenCreatedAt: Date | null;
  notifyChannel: string;
  /** Restriction de traitements non essentiels (issue #22). */
  processingRestrictedAt?: Date | null;
  /** Opposition aux traitements non essentiels (issue #22). */
  processingOpposedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const UserSchema = new EntitySchema<UserEntity>({
  name: 'User',
  tableName: 'users',
  // Unicité par club, et non globale (issue #266) : une même personne peut être
  // dirigeante — donc titulaire d'un compte, avec son propre mot de passe — dans
  // plusieurs clubs partageant cette instance. Chaque compte reste rattaché à un
  // seul club (pas de compte global multi-club ni de sélecteur de club à la
  // connexion) ; voir migrations/user-email-club-scoped.ts pour la conversion de
  // l'ancien index unique global, et le README (section Multi-club) pour la
  // décision de modèle.
  indices: [{ name: 'uq_users_club_email', columns: ['clubId', 'email'], unique: true }],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    clubId: { type: String, default: process.env.APP_CLUB_ID || 'afp' },
    email: { type: String },
    passwordHash: { type: String },
    nom: { type: String },
    accessRole: { type: String, default: 'dirigeant' },
    planningFunctions: { type: 'simple-json' },
    active: { type: Boolean, default: true },
    claimedAt: { type: 'datetime', nullable: true },
    closedAt: { type: 'datetime', nullable: true },
    closureRequestedAt: { type: 'datetime', nullable: true },
    closedByUserId: { type: Number, nullable: true },
    telephone: { type: String, nullable: true },
    indisponibilites: { type: 'simple-json', nullable: true },
    icalTokenHash: { type: String, nullable: true, unique: true },
    icalTokenCreatedAt: { type: 'datetime', nullable: true },
    notifyChannel: { type: String, default: 'push' },
    processingRestrictedAt: { type: 'datetime', nullable: true },
    processingOpposedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export interface UserSessionEntity {
  id: string;
  tokenHash: string;
  userId: number;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  idleTtlSeconds: number;
  absoluteTtlSeconds: number;
  revokedAt: Date | null;
  clientHint: string | null;
  networkHint: string | null;
  /** Instant de la dernière preuve de mot de passe (issue #32). */
  authenticatedAt: Date | null;
}

export const UserSessionSchema = new EntitySchema<UserSessionEntity>({
  name: 'UserSession',
  tableName: 'user_sessions',
  indices: [
    { name: 'idx_user_sessions_user_id', columns: ['userId'] },
    { name: 'idx_user_sessions_expires_at', columns: ['expiresAt'] },
    { name: 'uq_user_sessions_token_hash', columns: ['tokenHash'], unique: true },
  ],
  columns: {
    id: { type: String, primary: true },
    tokenHash: { type: String, length: 96 },
    userId: { type: Number },
    createdAt: { type: 'datetime', createDate: true },
    lastSeenAt: { type: 'datetime' },
    expiresAt: { type: 'datetime' },
    idleTtlSeconds: { type: Number },
    absoluteTtlSeconds: { type: Number },
    revokedAt: { type: 'datetime', nullable: true },
    clientHint: { type: String, nullable: true, length: 32 },
    networkHint: { type: String, nullable: true, length: 16 },
    authenticatedAt: { type: 'datetime', nullable: true },
  },
});

export interface InvitationEntity {
  id: string;
  clubId: string;
  email: string | null;
  /** Clé d'unicité pending : `clubId:email` tant que l'invitation est en attente (issue #386). */
  pendingEmailKey: string | null;
  /** Rôle d'accès proposé par l'invitation : 'admin' ou 'dirigeant' (issue #209). */
  accessRole: string;
  /** Fonctions opérationnelles proposées par l'invitation. */
  planningFunctions: string[];
  personNom: string | null;
  personType: string | null;
  personId: number | null;
  createdByUserId: number | null;
  createdByPlatformAdminId: number | null;
  /**
   * Confirmation explicite par l'administrateur invitant que la personne est majeure
   * (issue #18) : la V1 réserve les comptes aux adultes du staff tant qu'aucun parcours
   * mineur n'a été conçu. Horodatage de la confirmation uniquement — jamais de date de
   * naissance ni d'autre donnée d'âge collectée. `null` = invitation antérieure à cette
   * exigence (créée avant le déploiement) ; toute nouvelle invitation la requiert.
   */
  adultConfirmedAt: Date | null;
  expiresAt: Date;
  usedAt: Date | null;
  usedByUserId: number | null;
  createdAt: Date;
  /** Empreinte du contexte d'échange court (cookie), jamais le jeton d'URL (issue #34). */
  validationContextHash: string | null;
  validationContextExpiresAt: Date | null;
}

export const InvitationSchema = new EntitySchema<InvitationEntity>({
  name: 'Invitation',
  tableName: 'invitations',
  indices: [
    { name: 'idx_invitations_person', columns: ['personType', 'personId'] },
    { name: 'idx_invitations_validation_context', columns: ['validationContextHash'] },
  ],
  columns: {
    id: { type: String, primary: true },
    clubId: { type: String, default: process.env.APP_CLUB_ID || 'afp' },
    email: { type: String, nullable: true },
    pendingEmailKey: { type: String, nullable: true },
    accessRole: { type: String, default: 'dirigeant' },
    planningFunctions: { type: 'simple-json' },
    personNom: { type: String, nullable: true },
    personType: { type: String, nullable: true },
    personId: { type: Number, nullable: true },
    createdByUserId: { type: Number, nullable: true },
    createdByPlatformAdminId: { type: Number, nullable: true },
    adultConfirmedAt: { type: 'datetime', nullable: true },
    expiresAt: { type: 'datetime' },
    usedAt: { type: 'datetime', nullable: true },
    usedByUserId: { type: Number, nullable: true },
    createdAt: { type: 'datetime', createDate: true },
    validationContextHash: { type: String, length: 64, nullable: true },
    validationContextExpiresAt: { type: 'datetime', nullable: true },
  },
});

export interface MatchAuditLogEntity {
  id: number;
  clubId: string;
  entityType: string;
  entityId: string;
  action: string;
  userId: number | null;
  userEmail: string | null;
  userNom: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: Date;
}

export const MatchAuditLogSchema = new EntitySchema<MatchAuditLogEntity>({
  name: 'MatchAuditLog',
  tableName: 'match_audit_log',
  indices: [
    { name: 'idx_match_audit_log_entity', columns: ['clubId', 'entityType', 'entityId', 'createdAt'] },
    { name: 'idx_match_audit_log_created_at', columns: ['createdAt'] },
  ],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    // Tenant propriétaire de l'entrée (issue #126) — renseigné explicitement à
    // l'écriture, jamais déduit implicitement d'APP_CLUB_ID.
    clubId: { type: String },
    entityType: { type: String },
    entityId: { type: String },
    action: { type: String },
    userId: { type: Number, nullable: true },
    userEmail: { type: String, nullable: true },
    userNom: { type: String, nullable: true },
    before: { type: 'simple-json', nullable: true },
    after: { type: 'simple-json', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface NotificationEntity {
  id: number;
  userId: number;
  type: string;
  title: string;
  message: string;
  eventType: string | null;
  eventId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export const NotificationSchema = new EntitySchema<NotificationEntity>({
  name: 'Notification',
  tableName: 'notifications',
  indices: [
    { name: 'idx_notifications_user', columns: ['userId', 'createdAt'] },
    { name: 'idx_notifications_unread', columns: ['userId', 'readAt'] },
  ],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    userId: { type: Number },
    type: { type: String },
    title: { type: String },
    message: { type: 'text' },
    eventType: { type: String, nullable: true },
    eventId: { type: String, nullable: true },
    readAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface PasswordResetTokenEntity {
  tokenHash: string;
  userId: number;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export const PasswordResetTokenSchema = new EntitySchema<PasswordResetTokenEntity>({
  name: 'PasswordResetToken',
  tableName: 'password_reset_tokens',
  indices: [{ name: 'idx_password_reset_user', columns: ['userId', 'expiresAt'] }],
  columns: {
    tokenHash: { type: String, primary: true },
    userId: { type: Number },
    expiresAt: { type: 'datetime' },
    usedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export type ChatRoomKind = 'direct' | 'event' | 'channel';

export interface ChatRoomEntity {
  id: string;
  type: ChatRoomKind;
  clubId: string;
  roomKey: string;
  name: string | null;
  description: string | null;
  eventType: string | null;
  eventId: string | null;
  createdByUserId: number;
  nextSequence: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ChatRoomSchema = new EntitySchema<ChatRoomEntity>({
  name: 'ChatRoom',
  tableName: 'chat_rooms',
  indices: [
    { name: 'idx_chat_rooms_club_type', columns: ['clubId', 'type'] },
    { name: 'idx_chat_rooms_event', columns: ['clubId', 'eventType', 'eventId'] },
  ],
  columns: {
    id: { type: String, primary: true },
    type: { type: String },
    clubId: { type: String },
    roomKey: { type: String, unique: true },
    name: { type: String, nullable: true },
    description: { type: 'text', nullable: true },
    eventType: { type: String, nullable: true },
    eventId: { type: String, nullable: true },
    createdByUserId: { type: Number },
    nextSequence: { type: Number, default: 1 },
    archivedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export interface ChatParticipantEntity {
  roomId: string;
  userId: number;
  addedByUserId: number;
  createdAt: Date;
}

export const ChatParticipantSchema = new EntitySchema<ChatParticipantEntity>({
  name: 'ChatParticipant',
  tableName: 'chat_participants',
  indices: [{ name: 'idx_chat_participants_user', columns: ['userId', 'roomId'] }],
  columns: {
    roomId: { type: String, primary: true },
    userId: { type: Number, primary: true },
    addedByUserId: { type: Number },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export type ChatAttachmentType = 'image' | 'video' | 'audio' | 'gif' | 'document';

export interface ChatMessageEntity {
  id: string;
  roomId: string;
  senderUserId: number;
  senderName: string;
  clientMessageId: string;
  sequence: number;
  content: string;
  attachmentType: ChatAttachmentType | null;
  attachmentUrl: string | null;
  attachmentMimeType: string | null;
  attachmentName: string | null;
  attachmentSize: number | null;
  /** Réponse/citation à un autre message du même salon (issue #268). */
  replyToMessageId: string | null;
  /** Transfert depuis une autre conversation : nom de l'auteur d'origine (issue #268). */
  forwardedFromName: string | null;
  /** Identifiant de l'auteur d'origine, conservé pour permettre son anonymisation. */
  forwardedFromUserId: number | null;
  createdAt: Date;
  /** Modération admin (issue #259) : contenu et pièce jointe déjà purgés quand définie. */
  deletedAt: Date | null;
  deletedByUserId: number | null;
}

export const ChatMessageSchema = new EntitySchema<ChatMessageEntity>({
  name: 'ChatMessage',
  tableName: 'chat_messages',
  indices: [
    { name: 'uq_chat_messages_sequence', columns: ['roomId', 'sequence'], unique: true },
    {
      name: 'uq_chat_messages_client_id',
      columns: ['roomId', 'senderUserId', 'clientMessageId'],
      unique: true,
    },
    { name: 'idx_chat_messages_created_at', columns: ['roomId', 'createdAt'] },
  ],
  columns: {
    id: { type: String, primary: true },
    roomId: { type: String },
    senderUserId: { type: Number },
    senderName: { type: String },
    clientMessageId: { type: String },
    sequence: { type: Number },
    content: { type: 'text' },
    attachmentType: { type: String, nullable: true },
    attachmentUrl: { type: String, nullable: true },
    attachmentMimeType: { type: String, nullable: true },
    attachmentName: { type: String, nullable: true },
    attachmentSize: { type: Number, nullable: true },
    replyToMessageId: { type: String, nullable: true },
    forwardedFromName: { type: String, nullable: true },
    forwardedFromUserId: { type: Number, nullable: true },
    createdAt: { type: 'datetime', createDate: true },
    deletedAt: { type: 'datetime', nullable: true },
    deletedByUserId: { type: Number, nullable: true },
  },
});

export interface ChatReadStateEntity {
  roomId: string;
  userId: number;
  lastReadSequence: number;
  updatedAt: Date;
}

export interface ChatMessageReactionEntity {
  messageId: string;
  userId: number;
  emoji: string;
  createdAt: Date;
}

export const ChatMessageReactionSchema = new EntitySchema<ChatMessageReactionEntity>({
  name: 'ChatMessageReaction',
  tableName: 'chat_message_reactions',
  columns: {
    messageId: { type: String, primary: true },
    userId: { type: Number, primary: true },
    emoji: { type: String, primary: true, length: 32 },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export const ChatReadStateSchema = new EntitySchema<ChatReadStateEntity>({
  name: 'ChatReadState',
  tableName: 'chat_read_states',
  indices: [{ name: 'idx_chat_read_states_user', columns: ['userId', 'updatedAt'] }],
  columns: {
    roomId: { type: String, primary: true },
    userId: { type: Number, primary: true },
    lastReadSequence: { type: Number, default: 0 },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export interface ClubTenantEntity {
  id: string;
  name: string;
  abbreviation: string;
  description: string;
  logo: string;
  themeMode: string;
  primaryColor: string;
  secondaryColor: string;
  timeZone: string;
  matchesUrlKey: string;
  scraperClubName: string;
  featuresJson: string;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  smtpPasswordEncrypted: string | null;
  smtpFromEmail: string | null;
  smtpFromName: string | null;
  active: boolean;
  /** none | frozen | purged — issue #25 */
  offboardingStatus: string;
  frozenAt: Date | null;
  retentionUntil: Date | null;
  purgedAt: Date | null;
  legalHoldActive: boolean;
  legalHoldMotive: string | null;
  legalHoldScope: string | null;
  legalHoldExpiresAt: Date | null;
  legalHoldApprovedBy: number | null;
  legalHoldCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ClubTenantSchema = new EntitySchema<ClubTenantEntity>({
  name: 'ClubTenant',
  tableName: 'club_tenants',
  columns: {
    id: { type: String, primary: true },
    name: { type: String },
    abbreviation: { type: String, default: '' },
    description: { type: String, default: '' },
    logo: { type: 'text', default: '' },
    themeMode: { type: String, default: 'system' },
    primaryColor: { type: String, default: '#1f2937' },
    secondaryColor: { type: String, default: '#e5e7eb' },
    timeZone: { type: String, default: 'Europe/Paris' },
    matchesUrlKey: { type: String, default: '' },
    scraperClubName: { type: String, default: '' },
    featuresJson: { type: 'text', default: '{}' },
    smtpHost: { type: String, nullable: true },
    smtpPort: { type: Number, nullable: true },
    smtpSecure: { type: Boolean, default: false },
    smtpUser: { type: String, nullable: true },
    smtpPasswordEncrypted: { type: 'text', nullable: true },
    smtpFromEmail: { type: String, nullable: true },
    smtpFromName: { type: String, nullable: true },
    active: { type: Boolean, default: true },
    offboardingStatus: { type: String, default: 'none' },
    frozenAt: { type: 'datetime', nullable: true },
    retentionUntil: { type: 'datetime', nullable: true },
    purgedAt: { type: 'datetime', nullable: true },
    legalHoldActive: { type: Boolean, default: false },
    legalHoldMotive: { type: String, nullable: true },
    legalHoldScope: { type: String, nullable: true },
    legalHoldExpiresAt: { type: 'datetime', nullable: true },
    legalHoldApprovedBy: { type: Number, nullable: true },
    legalHoldCreatedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export interface PlatformAdminEntity {
  id: number;
  email: string;
  passwordHash: string;
  nom: string;
  active: boolean;
  totpSecretEncrypted: string | null;
  totpEnrolledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const PlatformAdminSchema = new EntitySchema<PlatformAdminEntity>({
  name: 'PlatformAdmin',
  tableName: 'platform_admins',
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    email: { type: String, unique: true },
    passwordHash: { type: String },
    nom: { type: String },
    active: { type: Boolean, default: true },
    totpSecretEncrypted: { type: 'text', nullable: true },
    totpEnrolledAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export interface PlatformSessionEntity {
  id: string;
  tokenHash: string;
  platformAdminId: number;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  idleTtlSeconds: number;
  absoluteTtlSeconds: number;
  revokedAt: Date | null;
  clientHint: string | null;
  networkHint: string | null;
  authenticatedAt: Date | null;
  mfaVerifiedAt: Date | null;
}

export const PlatformSessionSchema = new EntitySchema<PlatformSessionEntity>({
  name: 'PlatformSession',
  tableName: 'platform_sessions',
  indices: [
    { name: 'idx_platform_sessions_admin', columns: ['platformAdminId'] },
    { name: 'uq_platform_sessions_token_hash', columns: ['tokenHash'], unique: true },
  ],
  columns: {
    id: { type: String, primary: true },
    tokenHash: { type: String, length: 96 },
    platformAdminId: { type: Number },
    createdAt: { type: 'datetime', createDate: true },
    lastSeenAt: { type: 'datetime' },
    expiresAt: { type: 'datetime' },
    idleTtlSeconds: { type: Number },
    absoluteTtlSeconds: { type: Number },
    revokedAt: { type: 'datetime', nullable: true },
    clientHint: { type: String, nullable: true, length: 32 },
    networkHint: { type: String, nullable: true, length: 16 },
    authenticatedAt: { type: 'datetime', nullable: true },
    mfaVerifiedAt: { type: 'datetime', nullable: true },
  },
});

export interface PlatformMfaChallengeEntity {
  tokenHash: string;
  platformAdminId: number;
  purpose: string;
  totpSecretEncrypted: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export const PlatformMfaChallengeSchema = new EntitySchema<PlatformMfaChallengeEntity>({
  name: 'PlatformMfaChallenge',
  tableName: 'platform_mfa_challenges',
  indices: [{ name: 'idx_platform_mfa_challenges_admin', columns: ['platformAdminId'] }],
  columns: {
    tokenHash: { type: String, primary: true },
    platformAdminId: { type: Number },
    purpose: { type: String },
    totpSecretEncrypted: { type: 'text', nullable: true },
    expiresAt: { type: 'datetime' },
    consumedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface PlatformMfaRecoveryCodeEntity {
  id: number;
  platformAdminId: number;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

export const PlatformMfaRecoveryCodeSchema = new EntitySchema<PlatformMfaRecoveryCodeEntity>({
  name: 'PlatformMfaRecoveryCode',
  tableName: 'platform_mfa_recovery_codes',
  indices: [{ name: 'idx_platform_mfa_recovery_admin', columns: ['platformAdminId'] }],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    platformAdminId: { type: Number },
    codeHash: { type: String },
    usedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface PrivilegedAuthEventEntity {
  id: number;
  action: string;
  actorType: string;
  actorId: number | null;
  clubId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export const PrivilegedAuthEventSchema = new EntitySchema<PrivilegedAuthEventEntity>({
  name: 'PrivilegedAuthEvent',
  tableName: 'privileged_auth_events',
  indices: [{ name: 'idx_privileged_auth_events_created', columns: ['createdAt'] }],
  columns: {
    id: { type: Number, primary: true, generated: 'increment' },
    action: { type: String },
    actorType: { type: String },
    actorId: { type: Number, nullable: true },
    clubId: { type: String, nullable: true },
    metadata: { type: 'simple-json', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface PrivacyRequestEntity {
  id: string;
  clubId: string;
  type: string;
  status: string;
  subjectUserId: number | null;
  subjectEmailHash: string | null;
  identityVerifiedAt: Date | null;
  dueAt: Date | null;
  assigneeUserId: number | null;
  decisionCode: string | null;
  responseProof: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export const PrivacyRequestSchema = new EntitySchema<PrivacyRequestEntity>({
  name: 'PrivacyRequest',
  tableName: 'privacy_requests',
  indices: [
    { name: 'idx_privacy_requests_club', columns: ['clubId', 'createdAt'] },
    { name: 'idx_privacy_requests_subject', columns: ['clubId', 'subjectUserId'] },
  ],
  columns: {
    id: { type: String, primary: true },
    clubId: { type: String },
    type: { type: String },
    status: { type: String },
    subjectUserId: { type: Number, nullable: true },
    subjectEmailHash: { type: String, nullable: true },
    identityVerifiedAt: { type: 'datetime', nullable: true },
    dueAt: { type: 'datetime', nullable: true },
    assigneeUserId: { type: Number, nullable: true },
    decisionCode: { type: String, nullable: true },
    responseProof: { type: String, nullable: true },
    createdAt: { type: 'datetime', createDate: true },
    updatedAt: { type: 'datetime', updateDate: true },
    completedAt: { type: 'datetime', nullable: true },
  },
});

export interface PrivacyExportTokenEntity {
  id: string;
  clubId: string;
  userId: number;
  requestId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  downloadedAt: Date | null;
  createdAt: Date;
}

export const PrivacyExportTokenSchema = new EntitySchema<PrivacyExportTokenEntity>({
  name: 'PrivacyExportToken',
  tableName: 'privacy_export_tokens',
  indices: [{ name: 'idx_privacy_export_tokens_user', columns: ['clubId', 'userId'] }],
  columns: {
    id: { type: String, primary: true },
    clubId: { type: String },
    userId: { type: Number },
    requestId: { type: String },
    expiresAt: { type: 'datetime' },
    revokedAt: { type: 'datetime', nullable: true },
    downloadedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface PrivacyContactChangeEntity {
  id: string;
  clubId: string;
  userId: number;
  newEmail: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export const PrivacyContactChangeSchema = new EntitySchema<PrivacyContactChangeEntity>({
  name: 'PrivacyContactChange',
  tableName: 'privacy_contact_changes',
  columns: {
    id: { type: String, primary: true },
    clubId: { type: String },
    userId: { type: Number },
    newEmail: { type: String },
    expiresAt: { type: 'datetime' },
    usedAt: { type: 'datetime', nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface TenantOffboardingExportEntity {
  id: string;
  clubId: string;
  createdByPlatformAdminId: number;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
  manifestSha256: string | null;
  byteLength: number | null;
  createdAt: Date;
}

export const TenantOffboardingExportSchema = new EntitySchema<TenantOffboardingExportEntity>({
  name: 'TenantOffboardingExport',
  tableName: 'tenant_offboarding_exports',
  indices: [{ name: 'idx_tenant_offboarding_exports_club', columns: ['clubId', 'createdAt'] }],
  columns: {
    id: { type: String, primary: true, length: 64 },
    clubId: { type: String, length: 64 },
    createdByPlatformAdminId: { type: Number },
    expiresAt: { type: 'datetime' },
    usedAt: { type: 'datetime', nullable: true },
    revokedAt: { type: 'datetime', nullable: true },
    manifestSha256: { type: String, length: 64, nullable: true },
    byteLength: { type: Number, nullable: true },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface TenantProcessorInstructionEntity {
  id: string;
  clubId: string;
  processorId: string;
  status: string;
  instructedAt: Date;
  responseAt: Date | null;
}

export const TenantProcessorInstructionSchema = new EntitySchema<TenantProcessorInstructionEntity>({
  name: 'TenantProcessorInstruction',
  tableName: 'tenant_processor_instructions',
  indices: [{ name: 'idx_tenant_processor_instructions_club', columns: ['clubId', 'processorId'] }],
  columns: {
    id: { type: String, primary: true, length: 64 },
    clubId: { type: String, length: 64 },
    processorId: { type: String, length: 32 },
    status: { type: String, length: 32 },
    instructedAt: { type: 'datetime' },
    responseAt: { type: 'datetime', nullable: true },
  },
});

export interface TenantOffboardingEventEntity {
  id: string;
  clubId: string;
  action: string;
  platformAdminId: number | null;
  payloadJson: string;
  createdAt: Date;
}

export const TenantOffboardingEventSchema = new EntitySchema<TenantOffboardingEventEntity>({
  name: 'TenantOffboardingEvent',
  tableName: 'tenant_offboarding_events',
  indices: [{ name: 'idx_tenant_offboarding_events_club', columns: ['clubId', 'createdAt'] }],
  columns: {
    id: { type: String, primary: true, length: 64 },
    clubId: { type: String, length: 64 },
    action: { type: String, length: 64 },
    platformAdminId: { type: Number, nullable: true },
    payloadJson: { type: 'text' },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface TenantDeletionCertificateEntity {
  id: string;
  clubId: string;
  clubIdHash: string;
  createdByPlatformAdminId: number | null;
  payloadJson: string;
  createdAt: Date;
}

export const TenantDeletionCertificateSchema = new EntitySchema<TenantDeletionCertificateEntity>({
  name: 'TenantDeletionCertificate',
  tableName: 'tenant_deletion_certificates',
  indices: [{ name: 'idx_tenant_deletion_certificates_club', columns: ['clubId'] }],
  columns: {
    id: { type: String, primary: true, length: 64 },
    clubId: { type: String, length: 64 },
    clubIdHash: { type: String, length: 64 },
    createdByPlatformAdminId: { type: Number, nullable: true },
    payloadJson: { type: 'text' },
    createdAt: { type: 'datetime', createDate: true },
  },
});

export interface NonAccountContactMetaEntity {
  id: string;
  userId: number;
  clubId: string;
  category: string;
  provenance: string | null;
  purpose: string;
  collectedAt: Date;
  recordedByUserId: number;
  noticeVersion: string | null;
  noticeChannel: string;
  noticeAt: Date | null;
  noticeResult: string;
  opposedAt: Date | null;
  status: string;
}

export const NonAccountContactMetaSchema = new EntitySchema<NonAccountContactMetaEntity>({
  name: 'NonAccountContactMeta',
  tableName: 'non_account_contact_meta',
  indices: [
    { name: 'uq_non_account_contact_meta_user', columns: ['userId'], unique: true },
    { name: 'idx_non_account_contact_meta_club', columns: ['clubId'] },
  ],
  columns: {
    id: { type: String, primary: true },
    userId: { type: Number },
    clubId: { type: String },
    category: { type: String },
    provenance: { type: String, nullable: true },
    purpose: { type: String },
    collectedAt: { type: 'datetime' },
    recordedByUserId: { type: Number },
    noticeVersion: { type: String, nullable: true },
    noticeChannel: { type: String, default: 'not_sent' },
    noticeAt: { type: 'datetime', nullable: true },
    noticeResult: { type: String, default: 'pending' },
    opposedAt: { type: 'datetime', nullable: true },
    status: { type: String, default: 'active' },
  },
});

export interface ClubNoticeConfigEntity {
  clubId: string;
  noticeVersion: string;
  noticeText: string;
  updatedAt: Date;
}

export const ClubNoticeConfigSchema = new EntitySchema<ClubNoticeConfigEntity>({
  name: 'ClubNoticeConfig',
  tableName: 'club_notice_config',
  columns: {
    clubId: { type: String, primary: true },
    noticeVersion: { type: String, default: '' },
    noticeText: { type: 'text' },
    updatedAt: { type: 'datetime', updateDate: true },
  },
});

export interface NonAccountRightsRequestEntity {
  id: string;
  clubId: string;
  type: string;
  subjectEmailHash: string | null;
  subjectPhoneHash: string | null;
  status: string;
  createdAt: Date;
  processedAt: Date | null;
}

export const NonAccountRightsRequestSchema = new EntitySchema<NonAccountRightsRequestEntity>({
  name: 'NonAccountRightsRequest',
  tableName: 'non_account_rights_requests',
  indices: [
    { name: 'idx_non_account_rights_club', columns: ['clubId', 'createdAt'] },
    { name: 'idx_non_account_rights_hashes', columns: ['clubId', 'subjectEmailHash', 'subjectPhoneHash'] },
  ],
  columns: {
    id: { type: String, primary: true },
    clubId: { type: String },
    type: { type: String },
    subjectEmailHash: { type: String, nullable: true },
    subjectPhoneHash: { type: String, nullable: true },
    status: { type: String, default: 'received' },
    createdAt: { type: 'datetime', createDate: true },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export const allSchemas = [
  ClubSchema,
  CategorieSchema,
  StadeSchema,
  MatchOfficialSchema,
  MatchAmicalSchema,
  EntrainementSchema,
  PlateauSchema,
  MatchExtraSchema,
  AppMetaSchema,
  UserSchema,
  UserSessionSchema,
  InvitationSchema,
  MatchAuditLogSchema,
  NotificationSchema,
  PasswordResetTokenSchema,
  ChatRoomSchema,
  ChatParticipantSchema,
  ChatMessageSchema,
  ChatMessageReactionSchema,
  ChatReadStateSchema,
  ClubTenantSchema,
  PlatformAdminSchema,
  PlatformSessionSchema,
  PlatformMfaChallengeSchema,
  PlatformMfaRecoveryCodeSchema,
  PrivilegedAuthEventSchema,
  PrivacyRequestSchema,
  PrivacyExportTokenSchema,
  PrivacyContactChangeSchema,
  TenantOffboardingExportSchema,
  TenantProcessorInstructionSchema,
  TenantOffboardingEventSchema,
  TenantDeletionCertificateSchema,
  NonAccountContactMetaSchema,
  ClubNoticeConfigSchema,
  NonAccountRightsRequestSchema,
];
