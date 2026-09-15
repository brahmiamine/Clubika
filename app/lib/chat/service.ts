import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, In, IsNull, type QueryRunner } from 'typeorm';
import type { SessionUser } from '@/lib/auth/session';
import type {
  ChatMessageEntity,
  ChatMessageReactionEntity,
  ChatParticipantEntity,
  ChatReadStateEntity,
  ChatRoomEntity,
  ChatRoomKind,
  UserEntity,
} from '@/lib/db/schemas';
import { type PlanningEventSnapshot, type PlanningEventType } from '@/lib/planning/event-store';
import {
  assignedUserIdsForPlanningEvent,
  assignedUserIdsFromSnapshot,
  buildAssignedUserIdsByEventKey,
  resolvePublishedEventSnapshot,
} from '@/lib/planning/event-access';
import { hydratePlanningAssignmentStates } from '@/lib/planning/assignment-state-overlay';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { createTeamLogoResolver, type TeamLogoFields } from '@/lib/planning/team-logos';
import { canAccessChatRoom, directConversationKey, eventConversationKey } from './policy';
import type { ChatAttachmentInput, ChatMessageCommand } from './protocol';
import { CHAT_REACTION_EMOJIS, isChatReactionEmoji, type ChatReactionSummary } from './reactions';
import { readAppSettings } from '@/lib/settings-store';
import { decryptSecret, encryptSecret } from '@/lib/crypto/secret-box';
import {
  getChatAttachment,
  saveChatAttachment,
  type ChatAttachmentMeta,
  type ChatAttachmentRecord,
  withChatUploadQuota,
} from './attachments';

export interface ChatReplyPreviewDto {
  id: string;
  authorName: string;
  snippet: string;
  /** Le message cité n'a pas pu être retrouvé (salon purgé, incohérence de données). */
  deleted: boolean;
}

export interface ChatMessageDto {
  id: string;
  roomId: string;
  senderUserId: number;
  senderName: string;
  clientMessageId: string;
  sequence: number;
  content: string;
  attachment: ChatAttachmentInput | null;
  replyTo: ChatReplyPreviewDto | null;
  forwardedFromName: string | null;
  createdAt: string;
  /** Modération admin (issue #259) : contenu/pièce jointe déjà purgés quand non nul. */
  deletedAt: string | null;
  reactions: ChatReactionSummary[];
}

export interface ChatParticipantDto {
  id: number;
  nom: string;
  accessRole: string;
}

export interface ChatRoomDto {
  id: string;
  type: ChatRoomKind;
  name: string;
  description: string | null;
  eventType: string | null;
  eventId: string | null;
  participants: ChatParticipantDto[];
  lastMessage: ChatMessageDto | null;
  unreadCount: number;
  canManage: boolean;
  /** Salons d'événement : équipes et logos des deux clubs, pour le rendu visuel. */
  localTeam?: string;
  awayTeam?: string;
  localTeamLogo?: string;
  awayTeamLogo?: string;
}

export class ChatAccessError extends Error {}
export class ChatValidationError extends Error {}

/** Affiché à la place d'un contenu chiffré illisible (clé absente/changée, donnée
 * corrompue) plutôt que de laisser fuiter le texte chiffré dans le DTO (issue #261). */
const UNREADABLE_MESSAGE_PLACEHOLDER = '⚠️ Message illisible (clé de chiffrement invalide)';

const REPLY_SNIPPET_LENGTH = 140;

function replySnippet(source: ChatMessageEntity): string {
  const text = source.content ? decryptSecret(source.content) ?? UNREADABLE_MESSAGE_PLACEHOLDER : '';
  if (text) return text.length > REPLY_SNIPPET_LENGTH ? `${text.slice(0, REPLY_SNIPPET_LENGTH)}…` : text;
  return source.attachmentType ? 'Pièce jointe' : '';
}

/**
 * Résout, en une seule requête, les messages cités par `replyToMessageId` pour un lot
 * de messages (utilisé par `listMessages` et `listRooms` pour éviter un N+1).
 */
async function replyPreviewMap(
  db: Pick<DataSource, 'getRepository'>,
  messages: ChatMessageEntity[],
): Promise<Map<string, ChatMessageEntity>> {
  const ids = Array.from(new Set(messages.map((message) => message.replyToMessageId).filter((id): id is string => Boolean(id))));
  if (ids.length === 0) return new Map();
  const rows = await db.getRepository<ChatMessageEntity>('ChatMessage').findBy({ id: In(ids) });
  return new Map(rows.map((row) => [row.id, row]));
}

function messageDto(
  message: ChatMessageEntity,
  replyById?: Map<string, ChatMessageEntity>,
  reactions: ChatReactionSummary[] = [],
): ChatMessageDto {
  const replySource = message.replyToMessageId ? replyById?.get(message.replyToMessageId) : undefined;
  // Message supprimé par un admin : contenu et pièce jointe déjà purgés en base
  // (deleteMessage), donc rien à déchiffrer/exposer ici — juste le marqueur.
  if (message.deletedAt) {
    return {
      id: message.id,
      roomId: message.roomId,
      senderUserId: message.senderUserId,
      senderName: message.senderName,
      clientMessageId: message.clientMessageId,
      sequence: message.sequence,
      content: '',
      attachment: null,
      replyTo: null,
      forwardedFromName: null,
      createdAt: new Date(message.createdAt).toISOString(),
      deletedAt: new Date(message.deletedAt).toISOString(),
      reactions: [],
    };
  }
  return {
    id: message.id,
    roomId: message.roomId,
    senderUserId: message.senderUserId,
    senderName: message.senderName,
    clientMessageId: message.clientMessageId,
    sequence: message.sequence,
    content: message.content ? decryptSecret(message.content) ?? UNREADABLE_MESSAGE_PLACEHOLDER : '',
    attachment: message.attachmentType && message.attachmentUrl
      ? {
        type: message.attachmentType,
        url: message.attachmentUrl,
        mimeType: message.attachmentMimeType ?? '',
        name: message.attachmentName ?? '',
        size: message.attachmentSize ?? 0,
      }
      : null,
    replyTo: message.replyToMessageId
      ? (replySource
        ? { id: replySource.id, authorName: replySource.senderName, snippet: replySnippet(replySource), deleted: false }
        : { id: message.replyToMessageId, authorName: '', snippet: '', deleted: true })
      : null,
    forwardedFromName: message.forwardedFromName ?? null,
    createdAt: new Date(message.createdAt).toISOString(),
    deletedAt: null,
    reactions,
  };
}

async function reactionSummariesForMessages(
  db: Pick<DataSource, 'getRepository'> | EntityManager,
  messageIds: string[],
): Promise<Map<string, ChatReactionSummary[]>> {
  const summaries = new Map<string, ChatReactionSummary[]>();
  if (messageIds.length === 0) return summaries;
  const rows = await db.getRepository<ChatMessageReactionEntity>('ChatMessageReaction').findBy({
    messageId: In(messageIds),
  });
  const grouped = new Map<string, Map<string, number[]>>();
  for (const row of rows) {
    const byEmoji = grouped.get(row.messageId) ?? new Map<string, number[]>();
    const userIds = byEmoji.get(row.emoji) ?? [];
    userIds.push(row.userId);
    byEmoji.set(row.emoji, userIds);
    grouped.set(row.messageId, byEmoji);
  }
  for (const [messageId, byEmoji] of grouped) {
    const ordered: ChatReactionSummary[] = [];
    for (const emoji of CHAT_REACTION_EMOJIS) {
      const userIds = byEmoji.get(emoji);
      if (userIds?.length) ordered.push({ emoji, count: userIds.length, userIds });
    }
    summaries.set(messageId, ordered);
  }
  return summaries;
}

async function messageDtoWithReactions(
  db: Pick<DataSource, 'getRepository'> | EntityManager,
  message: ChatMessageEntity,
  replyById?: Map<string, ChatMessageEntity>,
): Promise<ChatMessageDto> {
  const reactionsById = await reactionSummariesForMessages(db, [message.id]);
  return messageDto(message, replyById, reactionsById.get(message.id) ?? []);
}

function validEventType(value: string): value is PlanningEventType {
  return value === 'officiel' || value === 'amical' || value === 'entrainement' || value === 'plateau';
}

async function participantIds(manager: EntityManager, roomId: string): Promise<number[]> {
  const rows = await manager.getRepository<ChatParticipantEntity>('ChatParticipant').findBy({ roomId });
  return rows.map((row) => row.userId);
}

async function roomForUser(
  manager: EntityManager,
  user: SessionUser,
  roomId: string,
): Promise<{ room: ChatRoomEntity; participantUserIds: number[]; eventAssignedUserIds: number[] }> {
  const room = await manager.getRepository<ChatRoomEntity>('ChatRoom').findOneBy({ id: roomId });
  if (!room) throw new ChatValidationError('Salon introuvable');
  return authorizeRoomForUser(manager, user, room);
}

/** Vérifie que l'utilisateur peut lire/écrire dans ce salon (ex : avant d'accepter un upload). */
export async function assertRoomAccess(db: DataSource, user: SessionUser, roomId: string): Promise<ChatRoomEntity> {
  const { room } = await roomForUser(db.manager, user, roomId);
  return room;
}

async function authorizeRoomForUser(
  manager: EntityManager,
  user: SessionUser,
  room: ChatRoomEntity,
): Promise<{ room: ChatRoomEntity; participantUserIds: number[]; eventAssignedUserIds: number[] }> {
  const ids = await participantIds(manager, room.id);
  let eventAssignedUserIds: number[] = [];
  if (room.type === 'event') {
    if (!room.eventType || !room.eventId || !validEventType(room.eventType)) {
      throw new ChatAccessError('Accès au salon refusé');
    }
    const snapshot = await resolvePublishedEventSnapshot(manager, room.clubId, room.eventType, room.eventId);
    if (!snapshot) throw new ChatAccessError('Cet événement n’est plus publié');
    eventAssignedUserIds = await assignedUserIdsForPlanningEvent(manager, snapshot);
  }
  if (!canAccessChatRoom(user, room, ids, eventAssignedUserIds)) throw new ChatAccessError('Accès au salon refusé');
  if (room.archivedAt) throw new ChatAccessError('Ce canal est archivé');
  if (room.type === 'event') {
    const eventChatEnabled = (await readAppSettings(manager, room.clubId)).features.eventChat;
    if (!eventChatEnabled) throw new ChatAccessError('Le chat des événements est désactivé par l\'administrateur');
    if (!(await isCurrentEventVisible(manager, room))) {
      throw new ChatAccessError('Cet événement n’est plus publié');
    }
  }
  return { room, participantUserIds: ids, eventAssignedUserIds };
}

/**
 * Clés (`eventType:eventId`) des événements actuellement publiés pour un club — une
 * seule lecture de `planning_records`, réutilisable pour vérifier plusieurs salons
 * d'événement à la fois (voir `listRooms`, qui interrogeait sinon cette même ligne
 * une fois par salon).
 */
async function publishedEventKeys(manager: EntityManager, clubId: string): Promise<Set<string>> {
  try {
    const publicationRows = await manager.query(
      'SELECT payload FROM planning_records WHERE id = ? AND club_id = ? AND kind = ? LIMIT 1',
      [`published-planning:${clubId}`, clubId, 'published-planning'],
    ) as Array<{ payload?: string }>;
    const raw = publicationRows[0]?.payload;
    if (!raw) return new Set();
    const payload = JSON.parse(raw) as { events?: PlanningEventSnapshot[] };
    return new Set((payload.events ?? []).map((snapshot) => `${snapshot.eventType}:${snapshot.eventId}`));
  } catch {
    // Snapshot absent, table indisponible ou payload illisible : aucun fallback live.
    return new Set();
  }
}

function eventRoomKey(room: Pick<ChatRoomEntity, 'eventType' | 'eventId'>): string {
  return `${room.eventType}:${room.eventId}`;
}

async function isCurrentEventVisible(manager: EntityManager, room: ChatRoomEntity): Promise<boolean> {
  if (!room.eventType || !room.eventId || !validEventType(room.eventType)) return false;
  const keys = await publishedEventKeys(manager, room.clubId);
  return keys.has(eventRoomKey(room));
}

/** Dernier message de chaque salon, en une seule requête agrégée (évite un N+1 dans `listRooms`). */
async function lastMessagesByRoom(db: DataSource, roomIds: string[]): Promise<Map<string, ChatMessageEntity>> {
  if (roomIds.length === 0) return new Map();
  const placeholders = roomIds.map(() => '?').join(',');
  const rows = await db.manager.query(
    `SELECT m.* FROM chat_messages m
     INNER JOIN (
       SELECT roomId, MAX(sequence) AS maxSequence FROM chat_messages WHERE roomId IN (${placeholders}) GROUP BY roomId
     ) latest ON latest.roomId = m.roomId AND latest.maxSequence = m.sequence`,
    roomIds,
  ) as ChatMessageEntity[];
  return new Map(rows.map((row) => [row.roomId, row]));
}

/** Nombre de messages non lus par salon pour un utilisateur, en une seule requête agrégée
 * (évite un N+1 dans `listRooms`). */
async function unreadCountsByRoom(db: DataSource, roomIds: string[], userId: number): Promise<Map<string, number>> {
  if (roomIds.length === 0) return new Map();
  const placeholders = roomIds.map(() => '?').join(',');
  const rows = await db.manager.query(
    `SELECT m.roomId AS roomId, COUNT(*) AS unread
     FROM chat_messages m
     LEFT JOIN chat_read_states r ON r.roomId = m.roomId AND r.userId = ?
     WHERE m.roomId IN (${placeholders})
       AND m.senderUserId != ?
       AND m.sequence > COALESCE(r.lastReadSequence, 0)
     GROUP BY m.roomId`,
    [userId, ...roomIds, userId],
  ) as Array<{ roomId: string; unread: number | string }>;
  return new Map(rows.map((row) => [row.roomId, Number(row.unread)]));
}

async function usersInClub(
  manager: EntityManager,
  clubId: string,
  ids: readonly number[],
): Promise<UserEntity[]> {
  if (ids.length === 0) return [];
  const uniqueIds = Array.from(new Set(ids));
  const users = await manager.getRepository<UserEntity>('User').findBy({
    id: In(uniqueIds),
    clubId,
    active: true,
  });
  if (users.length !== uniqueIds.length) {
    throw new ChatValidationError('Un ou plusieurs participants sont invalides');
  }
  return users;
}

async function saveParticipants(
  manager: EntityManager,
  roomId: string,
  userIds: readonly number[],
  addedByUserId: number,
): Promise<void> {
  const repository = manager.getRepository<ChatParticipantEntity>('ChatParticipant');
  const rows = Array.from(new Set(userIds)).map((userId) => ({ roomId, userId, addedByUserId }));
  if (rows.length > 0) await repository.insert(rows);
}

export async function listChatUsers(db: DataSource, user: SessionUser): Promise<ChatParticipantDto[]> {
  const users = await db.getRepository<UserEntity>('User').find({
    where: { clubId: user.clubId, active: true },
    order: { nom: 'ASC' },
  });
  return users.map((item) => ({ id: item.id, nom: item.nom, accessRole: item.accessRole }));
}

export async function getOrCreateDirectRoom(
  db: DataSource,
  user: SessionUser,
  targetUserId: number,
): Promise<ChatRoomEntity> {
  if (!Number.isInteger(targetUserId) || targetUserId <= 0 || targetUserId === user.id) {
    throw new ChatValidationError('Destinataire invalide');
  }
  const roomKey = directConversationKey(user.clubId, user.id, targetUserId);
  const existing = await db.getRepository<ChatRoomEntity>('ChatRoom').findOneBy({ roomKey });
  if (existing) return existing;

  try {
    return await db.transaction(async (manager) => {
      await usersInClub(manager, user.clubId, [user.id, targetUserId]);
      const room = manager.getRepository<ChatRoomEntity>('ChatRoom').create({
        id: randomUUID(),
        type: 'direct',
        clubId: user.clubId,
        roomKey,
        name: null,
        description: null,
        eventType: null,
        eventId: null,
        createdByUserId: user.id,
        nextSequence: 1,
        archivedAt: null,
      });
      await manager.getRepository<ChatRoomEntity>('ChatRoom').save(room);
      await saveParticipants(manager, room.id, [user.id, targetUserId], user.id);
      return room;
    });
  } catch (error) {
    const concurrent = await db.getRepository<ChatRoomEntity>('ChatRoom').findOneBy({ roomKey });
    if (concurrent) return concurrent;
    throw error;
  }
}

export async function listChatEvents(db: DataSource, user: SessionUser) {
  const snapshots = await listPublishedPlanningEventSnapshots(db);
  if (!snapshots) return [];
  const hydrated = await hydratePlanningAssignmentStates(db, snapshots, user.clubId);
  const activeUsers = await db.getRepository<UserEntity>('User').find({
    where: { active: true, clubId: user.clubId },
  });
  const assignedByKey = buildAssignedUserIdsByEventKey(hydrated, activeUsers);
  const accessible: PlanningEventSnapshot[] = [];
  for (const snapshot of hydrated) {
    const assignedIds = assignedByKey.get(`${snapshot.eventType}:${snapshot.eventId}`) ?? [];
    if (canAccessChatRoom(
      user,
      { type: 'event', clubId: user.clubId, createdByUserId: user.id },
      [],
      assignedIds,
    )) {
      accessible.push(snapshot);
    }
  }
  let resolveLogos: ((event: unknown) => TeamLogoFields) | null = null;
  try {
    const resolver = await createTeamLogoResolver(db, user.clubId);
    resolveLogos = (event) => resolver(event as Parameters<typeof resolver>[0]);
  } catch {
    resolveLogos = null;
  }
  return accessible
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`))
    .map((snapshot) => ({
      eventType: snapshot.eventType,
      eventId: snapshot.eventId,
      title: snapshot.title,
      date: snapshot.date,
      time: snapshot.time,
      location: snapshot.location,
      planningStatus: snapshot.planningStatus,
      ...(resolveLogos ? resolveLogos((snapshot as { event?: unknown }).event) : {}),
    }));
}

export async function getOrCreateEventRoom(
  db: DataSource,
  user: SessionUser,
  eventType: string,
  eventId: string,
): Promise<ChatRoomEntity> {
  if (!validEventType(eventType) || !eventId || eventId.length > 200) {
    throw new ChatValidationError('Événement invalide');
  }
  const published = await listPublishedPlanningEventSnapshots(db);
  const snapshot = published?.find(
    (item) => item.eventType === eventType && item.eventId === eventId,
  ) ?? null;
  if (!snapshot) throw new ChatValidationError('Événement introuvable');

  const hydrated = (await hydratePlanningAssignmentStates(db, [snapshot], user.clubId))[0] ?? snapshot;
  const assignedIds = await assignedUserIdsForPlanningEvent(db, hydrated);
  if (!canAccessChatRoom(
    user,
    { type: 'event', clubId: user.clubId, createdByUserId: user.id },
    [],
    assignedIds,
  )) {
    throw new ChatAccessError('Accès au salon refusé');
  }

  const roomKey = eventConversationKey(user.clubId, eventType, eventId);
  const existing = await db.getRepository<ChatRoomEntity>('ChatRoom').findOneBy({ roomKey });
  if (existing) return existing;

  try {
    return await db.getRepository<ChatRoomEntity>('ChatRoom').save({
      id: randomUUID(),
      type: 'event',
      clubId: user.clubId,
      roomKey,
      name: snapshot.title,
      description: [snapshot.date, snapshot.time, snapshot.location].filter(Boolean).join(' · '),
      eventType,
      eventId,
      createdByUserId: user.id,
      nextSequence: 1,
      archivedAt: null,
    });
  } catch (error) {
    const concurrent = await db.getRepository<ChatRoomEntity>('ChatRoom').findOneBy({ roomKey });
    if (concurrent) return concurrent;
    throw error;
  }
}

function normalizedChannelInput(value: unknown): { name: string; description: string | null } {
  const body = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (name.length < 2 || name.length > 100) throw new ChatValidationError('Nom du canal invalide');
  if (description.length > 500) throw new ChatValidationError('Description trop longue');
  return { name, description: description || null };
}

function requireAdmin(user: SessionUser): void {
  if (user.accessRole !== 'admin') {
    throw new ChatAccessError('Gestion des canaux réservée aux administrateurs');
  }
}

export async function createChannel(
  db: DataSource,
  user: SessionUser,
  input: unknown,
  participantUserIds: readonly number[],
): Promise<ChatRoomEntity> {
  requireAdmin(user);
  const channel = normalizedChannelInput(input);
  const selected = Array.from(new Set([user.id, ...participantUserIds]));
  if (selected.length > 500) throw new ChatValidationError('Trop de participants');

  return db.transaction(async (manager) => {
    await usersInClub(manager, user.clubId, selected);
    const id = randomUUID();
    const room = manager.getRepository<ChatRoomEntity>('ChatRoom').create({
      id,
      type: 'channel',
      clubId: user.clubId,
      roomKey: `channel:${user.clubId}:${id}`,
      name: channel.name,
      description: channel.description,
      eventType: null,
      eventId: null,
      createdByUserId: user.id,
      nextSequence: 1,
      archivedAt: null,
    });
    await manager.getRepository<ChatRoomEntity>('ChatRoom').save(room);
    await saveParticipants(manager, room.id, selected, user.id);
    return room;
  });
}

export async function updateChannel(
  db: DataSource,
  user: SessionUser,
  roomId: string,
  input: unknown,
  participantUserIds: readonly number[],
): Promise<ChatRoomEntity> {
  requireAdmin(user);
  const channel = normalizedChannelInput(input);
  const selected = Array.from(new Set([user.id, ...participantUserIds]));
  if (selected.length > 500) throw new ChatValidationError('Trop de participants');

  return db.transaction(async (manager) => {
    const room = await manager
      .getRepository<ChatRoomEntity>('ChatRoom')
      .createQueryBuilder('room')
      .setLock('pessimistic_write')
      .where('room.id = :roomId', { roomId })
      .getOne();
    if (!room || room.type !== 'channel') throw new ChatValidationError('Canal introuvable');
    if (room.clubId !== user.clubId) throw new ChatAccessError('Accès au canal refusé');
    await usersInClub(manager, user.clubId, selected);
    room.name = channel.name;
    room.description = channel.description;
    await manager.getRepository<ChatRoomEntity>('ChatRoom').save(room);
    await manager.getRepository<ChatParticipantEntity>('ChatParticipant').delete({ roomId });
    await saveParticipants(manager, room.id, selected, user.id);
    return room;
  });
}

export async function archiveChannel(db: DataSource, user: SessionUser, roomId: string): Promise<void> {
  requireAdmin(user);
  await db.transaction(async (manager) => {
    const room = await manager
      .getRepository<ChatRoomEntity>('ChatRoom')
      .createQueryBuilder('room')
      .setLock('pessimistic_write')
      .where('room.id = :roomId', { roomId })
      .getOne();
    if (!room || room.type !== 'channel') throw new ChatValidationError('Canal introuvable');
    if (room.clubId !== user.clubId) throw new ChatAccessError('Accès au canal refusé');
    room.archivedAt = new Date();
    await manager.getRepository<ChatRoomEntity>('ChatRoom').save(room);
  });
}

export async function listMessages(
  db: DataSource,
  user: SessionUser,
  roomId: string,
  options?: { afterSequence?: number; beforeSequence?: number; limit?: number },
): Promise<{
  room: ChatRoomEntity;
  participantUserIds: number[];
  messages: ChatMessageDto[];
  peerReadSequence: number;
  hasMoreBefore: boolean;
}> {
  const { room, participantUserIds } = await roomForUser(db.manager, user, roomId);
  const limit = Math.max(1, Math.min(options?.limit ?? 100, 200));
  // `beforeSequence` (pagination arrière, chargement des messages plus anciens) prime
  // sur `afterSequence` (reprise/reconnexion) si les deux sont fournis par erreur.
  const beforeSequence = options?.beforeSequence && options.beforeSequence > 0 ? options.beforeSequence : undefined;
  const afterSequence = !beforeSequence && options?.afterSequence && options.afterSequence > 0 ? options.afterSequence : undefined;
  const query = db
    .getRepository<ChatMessageEntity>('ChatMessage')
    .createQueryBuilder('message')
    .where('message.roomId = :roomId', { roomId })
    .orderBy('message.sequence', afterSequence ? 'ASC' : 'DESC')
    // Pagination arrière/chargement initial (DESC) : une page de plus que demandé pour
    // savoir s'il reste des messages plus anciens, sans dépendre d'un COUNT séparé.
    // Reprise en avant (afterSequence, ASC) : exactement `limit`, sinon le client
    // (`resumeFrom`, qui boucle tant qu'il reçoit exactement `limit` lignes) recevrait
    // systématiquement une ligne de trop et arrêterait la pagination prématurément.
    .take(afterSequence ? limit : limit + 1);
  if (afterSequence) {
    query.andWhere('message.sequence > :afterSequence', { afterSequence });
  } else if (beforeSequence) {
    query.andWhere('message.sequence < :beforeSequence', { beforeSequence });
  }
  const rows = await query.getMany();
  const hasMoreBefore = !afterSequence && rows.length > limit;
  const messages = hasMoreBefore ? rows.slice(0, limit) : rows;
  if (!afterSequence) messages.reverse();
  const otherIds = participantUserIds.filter((id) => id !== user.id);
  const peerReadStates = otherIds.length
    ? await db.getRepository<ChatReadStateEntity>('ChatReadState').findBy({ roomId, userId: In(otherIds) })
    : [];
  const peerReadSequence = peerReadStates.reduce((max, state) => Math.max(max, state.lastReadSequence), 0);
  const replyById = await replyPreviewMap(db, messages);
  const reactionsById = await reactionSummariesForMessages(db, messages.map((message) => message.id));
  return {
    room,
    participantUserIds,
    messages: messages.map((message) => messageDto(message, replyById, reactionsById.get(message.id) ?? [])),
    peerReadSequence,
    hasMoreBefore,
  };
}

function attachmentInputFromRecord(attachment: ChatAttachmentMeta): ChatAttachmentInput {
  return {
    type: attachment.kind,
    url: `/api/chat/attachments/${attachment.id}`,
    mimeType: attachment.mimeType,
    name: attachment.fileName,
    size: attachment.sizeBytes,
  };
}

interface ResolvedForwardSource {
  content: string;
  attachment: ChatAttachmentRecord | null;
  forwardedFromName: string;
  forwardedFromUserId: number;
}

type AppendMessageResult = {
  room: ChatRoomEntity;
  participantUserIds: number[];
  eventAssignedUserIds: number[];
  message: ChatMessageDto;
  duplicate: boolean;
};

/**
 * Résout tout le contenu transféré depuis le message validé. Le client ne choisit ni
 * le texte, ni la pièce jointe, ni l'attribution affichée : cela empêcherait de faire
 * passer un contenu fabriqué pour celui d'un autre membre.
 */
async function resolveForwardSource(
  manager: EntityManager,
  user: SessionUser,
  forwardSourceMessageId: string,
): Promise<ResolvedForwardSource> {
  const sourceQuery = manager
    .getRepository<ChatMessageEntity>('ChatMessage')
    .createQueryBuilder('message')
    .where('message.id = :id', { id: forwardSourceMessageId });
  // Dans appendMessage, le verrou reste détenu jusqu'à l'insertion cible : une
  // modération ou anonymisation concurrente ne peut donc pas rendre la copie obsolète
  // entre la validation de la source et le commit du transfert.
  if (manager.queryRunner?.isTransactionActive) sourceQuery.setLock('pessimistic_read');
  const source = await sourceQuery.getOne();
  if (!source) throw new ChatValidationError('Message à transférer introuvable');
  await roomForUser(manager, user, source.roomId);
  if (source.deletedAt) throw new ChatValidationError('Un message supprimé ne peut pas être transféré');

  const content = source.content ? decryptSecret(source.content) : '';
  if (source.content && content === null) {
    throw new ChatValidationError('Message à transférer illisible');
  }

  let attachment: ChatAttachmentRecord | null = null;
  if (source.attachmentUrl) {
    const attachmentId = source.attachmentUrl.split('/').pop() ?? '';
    attachment = await getChatAttachment(manager, attachmentId);
    if (!attachment || attachment.clubId !== user.clubId || attachment.roomId !== source.roomId) {
      throw new ChatValidationError('Pièce jointe du message à transférer introuvable');
    }
  }
  if (!content && !attachment) throw new ChatValidationError('Message à transférer vide');

  return {
    content: content ?? '',
    attachment,
    forwardedFromName: source.forwardedFromName ?? source.senderName,
    forwardedFromUserId: source.forwardedFromUserId ?? source.senderUserId,
  };
}

type CrossRoomAttachmentCopier = (
  runner: QueryRunner,
  attachment: ChatAttachmentRecord,
) => Promise<ChatAttachmentMeta>;

async function duplicateMessageResult(
  manager: EntityManager,
  user: SessionUser,
  command: ChatMessageCommand,
  access?: { room: ChatRoomEntity; participantUserIds: number[]; eventAssignedUserIds: number[] },
): Promise<AppendMessageResult | undefined> {
  const duplicate = await manager.getRepository<ChatMessageEntity>('ChatMessage').findOneBy({
    roomId: command.roomId,
    senderUserId: user.id,
    clientMessageId: command.clientMessageId,
  });
  if (!duplicate) return undefined;
  const roomAccess = access ?? await roomForUser(manager, user, command.roomId);
  const replyById = await replyPreviewMap(manager, [duplicate]);
  return { ...roomAccess, message: await messageDtoWithReactions(manager, duplicate, replyById), duplicate: true };
}

async function appendMessageInTransaction(
  manager: EntityManager,
  user: SessionUser,
  command: ChatMessageCommand,
  copyCrossRoomAttachment?: CrossRoomAttachmentCopier,
): Promise<AppendMessageResult> {
  const room = await manager
    .getRepository<ChatRoomEntity>('ChatRoom')
    .createQueryBuilder('room')
    .setLock('pessimistic_write')
    .where('room.id = :roomId', { roomId: command.roomId })
    .getOne();
  if (!room) throw new ChatValidationError('Salon introuvable');
  const access = await authorizeRoomForUser(manager, user, room);
  const messageRepository = manager.getRepository<ChatMessageEntity>('ChatMessage');
  const duplicate = await duplicateMessageResult(manager, user, command, access);
  if (duplicate) return duplicate;

  let replySource: ChatMessageEntity | null = null;
  if (command.replyToMessageId) {
    replySource = await messageRepository.findOneBy({ id: command.replyToMessageId, roomId: room.id });
    if (!replySource) throw new ChatValidationError('Message cité introuvable');
  }

  const forwardSource = command.forwardSourceMessageId
    ? await resolveForwardSource(manager, user, command.forwardSourceMessageId)
    : null;

  let attachment: ChatAttachmentInput | null = null;
  if (forwardSource?.attachment) {
    if (forwardSource.attachment.roomId === room.id) {
      attachment = attachmentInputFromRecord(forwardSource.attachment);
    } else {
      if (!copyCrossRoomAttachment || !manager.queryRunner) {
        throw new ChatValidationError('Transfert de pièce jointe impossible');
      }
      const copy = await copyCrossRoomAttachment(manager.queryRunner, forwardSource.attachment);
      attachment = attachmentInputFromRecord(copy);
    }
  } else if (!forwardSource && command.attachment) {
    const attachmentId = command.attachment.url.split('/').pop() ?? '';
    const stored = await getChatAttachment(manager, attachmentId);
    if (!stored || stored.clubId !== user.clubId) {
      throw new ChatValidationError('Pièce jointe introuvable dans ce salon');
    }
    if (stored.roomId !== room.id) {
      await roomForUser(manager, user, stored.roomId);
      throw new ChatValidationError('Une pièce jointe provenant d’un autre salon doit être transférée avec son message');
    }
    attachment = attachmentInputFromRecord(stored);
  }

  const sequence = room.nextSequence;
  room.nextSequence += 1;
  await manager.getRepository<ChatRoomEntity>('ChatRoom').save(room);
  const saved = await messageRepository.save({
    id: randomUUID(),
    roomId: room.id,
    senderUserId: user.id,
    senderName: user.nom,
    clientMessageId: command.clientMessageId,
    sequence,
    content: (forwardSource?.content ?? command.content) ? encryptSecret(forwardSource?.content ?? command.content) : '',
    attachmentType: attachment?.type ?? null,
    attachmentUrl: attachment?.url ?? null,
    attachmentMimeType: attachment?.mimeType ?? null,
    attachmentName: attachment?.name ?? null,
    attachmentSize: attachment?.size ?? null,
    replyToMessageId: command.replyToMessageId ?? null,
    forwardedFromName: forwardSource?.forwardedFromName ?? null,
    forwardedFromUserId: forwardSource?.forwardedFromUserId ?? null,
  });
  const replyById = replySource ? new Map([[replySource.id, replySource]]) : undefined;
  return { room, participantUserIds: access.participantUserIds, eventAssignedUserIds: access.eventAssignedUserIds, message: messageDto(saved, replyById), duplicate: false };
}

export async function appendMessage(
  db: DataSource,
  user: SessionUser,
  command: ChatMessageCommand,
): Promise<AppendMessageResult> {
  // Pré-contrôle d'idempotence, avant tout effet de bord coûteux (copie de pièce
  // jointe transférée, qui consomme le quota d'upload) : un retry avec le même
  // clientMessageId ne doit ni recopier le fichier ni le compter deux fois. Ce n'est
  // qu'une optimisation — la vérification déterminante reste celle, transactionnelle,
  // plus bas, seule à l'abri d'une course entre deux retries vraiment simultanés.
  const precheckDuplicate = await db.getRepository<ChatMessageEntity>('ChatMessage').findOneBy({
    roomId: command.roomId,
    senderUserId: user.id,
    clientMessageId: command.clientMessageId,
  });
  if (precheckDuplicate) {
    const { room, participantUserIds, eventAssignedUserIds } = await roomForUser(db.manager, user, command.roomId);
    const replyById = await replyPreviewMap(db, [precheckDuplicate]);
    return {
      room,
      participantUserIds,
      eventAssignedUserIds,
      message: await messageDtoWithReactions(db, precheckDuplicate, replyById),
      duplicate: true,
    };
  }

  // Une prélecture ne décide que si le verrou de quota est nécessaire. La source est
  // relue et validée dans la transaction avant toute copie ou insertion.
  const forwardPreview = command.forwardSourceMessageId
    ? await resolveForwardSource(db.manager, user, command.forwardSourceMessageId)
    : null;
  const needsCrossRoomCopy = Boolean(
    forwardPreview?.attachment && forwardPreview.attachment.roomId !== command.roomId,
  );

  if (needsCrossRoomCopy && forwardPreview?.attachment) {
    return withChatUploadQuota(db, {
      clubId: user.clubId,
      uploadedByUserId: user.id,
      incomingBytes: forwardPreview.attachment.sizeBytes,
    }, async (runner) => appendMessageInTransaction(
      runner.manager,
      user,
      command,
      (activeRunner, source) => saveChatAttachment(activeRunner, {
        clubId: user.clubId,
        roomId: command.roomId,
        kind: source.kind,
        fileName: source.fileName,
        mimeType: source.mimeType,
        content: source.content,
        uploadedByUserId: user.id,
      }),
    ), (runner) => duplicateMessageResult(runner.manager, user, command));
  }

  return db.transaction((manager) => appendMessageInTransaction(manager, user, command));
}

/**
 * Modération admin (issue #259) : purge le contenu et la pièce jointe d'un message,
 * conserve la ligne (identifiant, expéditeur, séquence) pour ne pas perturber la
 * pagination ni le compteur de non-lus. Réservé aux administrateurs du club, et
 * seulement pour un salon auquel ils ont eux-mêmes accès (un admin ne peut pas
 * modérer une conversation privée dont il n'est pas participant).
 */
export async function deleteMessage(
  db: DataSource,
  user: SessionUser,
  roomId: string,
  messageId: string,
): Promise<{ room: ChatRoomEntity; participantUserIds: number[]; message: ChatMessageDto }> {
  requireAdmin(user);
  return db.transaction(async (manager) => {
    const room = await manager
      .getRepository<ChatRoomEntity>('ChatRoom')
      .createQueryBuilder('room')
      .setLock('pessimistic_write')
      .where('room.id = :roomId', { roomId })
      .getOne();
    if (!room) throw new ChatValidationError('Salon introuvable');
    const access = await authorizeRoomForUser(manager, user, room);
    const messageRepository = manager.getRepository<ChatMessageEntity>('ChatMessage');
    const message = await messageRepository.findOneBy({ id: messageId, roomId });
    if (!message) throw new ChatValidationError('Message introuvable');
    if (!message.deletedAt) {
      // Purge aussi le blob en base (chat_attachments), pas seulement la référence sur
      // le message : sinon l'URL reste servable par quiconque l'a conservée, et le
      // fichier continue de compter dans le quota d'upload (revue Codex).
      if (message.attachmentUrl) {
        const attachmentId = message.attachmentUrl.split('/').pop();
        if (attachmentId) await manager.query('DELETE FROM chat_attachments WHERE id = ?', [attachmentId]);
      }
      message.deletedAt = new Date();
      message.deletedByUserId = user.id;
      message.content = '';
      message.attachmentType = null;
      message.attachmentUrl = null;
      message.attachmentMimeType = null;
      message.attachmentName = null;
      message.attachmentSize = null;
      await messageRepository.save(message);
      await manager.getRepository<ChatMessageReactionEntity>('ChatMessageReaction').delete({ messageId });
    }
    return { room, participantUserIds: access.participantUserIds, message: messageDto(message) };
  });
}

export async function toggleMessageReaction(
  db: DataSource,
  user: SessionUser,
  roomId: string,
  messageId: string,
  emoji: string,
): Promise<{
  room: ChatRoomEntity;
  participantUserIds: number[];
  eventAssignedUserIds: number[];
  messageId: string;
  message: ChatMessageDto;
  reactions: ChatReactionSummary[];
  added: boolean;
}> {
  if (!isChatReactionEmoji(emoji)) throw new ChatValidationError('Emoji non autorisé');

  return db.transaction(async (manager) => {
    const { room, participantUserIds, eventAssignedUserIds } = await roomForUser(manager, user, roomId);
    const message = await manager.getRepository<ChatMessageEntity>('ChatMessage').findOneBy({ id: messageId, roomId });
    if (!message) throw new ChatValidationError('Message introuvable');
    if (message.deletedAt) throw new ChatValidationError('Message supprimé');

    const repository = manager.getRepository<ChatMessageReactionEntity>('ChatMessageReaction');
    const existing = await repository.findOneBy({ messageId, userId: user.id, emoji });
    const added = !existing;
    if (existing) {
      await repository.remove(existing);
    } else {
      await repository.save({
        messageId,
        userId: user.id,
        emoji,
        createdAt: new Date(),
      });
    }

    const dto = await messageDtoWithReactions(manager, message);
    return {
      room,
      participantUserIds,
      eventAssignedUserIds,
      messageId,
      message: dto,
      reactions: dto.reactions ?? [],
      added,
    };
  });
}

/**
 * Anonymise l'attribution des messages d'un compte supprimé (issue #259) : `senderName`
 * est dénormalisé en clair sur chat_messages pour l'affichage, ce qui contournerait
 * sinon partiellement le chiffrement au repos pour l'identité de l'auteur après
 * suppression du compte. Le contenu des messages n'est pas purgé — seule l'identité.
 */
export const ANONYMIZED_SENDER_NAME = 'Utilisateur supprimé';

/**
 * Accepte un `EntityManager` déjà ouvert (issue #273 : appelée depuis la transaction
 * de suppression de compte, pour que l'anonymisation et la suppression de la ligne
 * `users` réussissent ou échouent ensemble) ou un `DataSource`, auquel cas elle ouvre
 * sa propre transaction — compatible avec les appelants existants.
 */
export async function anonymizeMessagesForDeletedUser(db: DataSource | EntityManager, userId: number): Promise<void> {
  const run = async (manager: EntityManager) => {
    const repository = manager.getRepository<ChatMessageEntity>('ChatMessage');
    await repository.update(
      { senderUserId: userId },
      { senderName: ANONYMIZED_SENDER_NAME },
    );
    await repository.update(
      { forwardedFromUserId: userId },
      { forwardedFromName: ANONYMIZED_SENDER_NAME },
    );
  };
  if (db instanceof EntityManager) {
    await run(db);
  } else {
    await db.transaction(run);
  }
}

export async function markRoomRead(
  db: DataSource,
  user: SessionUser,
  roomId: string,
  sequence: number,
): Promise<{ room: ChatRoomEntity }> {
  const { room } = await roomForUser(db.manager, user, roomId);
  if (!Number.isInteger(sequence) || sequence < 0) throw new ChatValidationError('Séquence invalide');
  const repository = db.getRepository<ChatReadStateEntity>('ChatReadState');
  const existing = await repository.findOneBy({ roomId, userId: user.id });
  if (!existing || existing.lastReadSequence < sequence) {
    await repository.save({ roomId, userId: user.id, lastReadSequence: sequence });
  }
  return { room };
}

export async function participantIdsForRoom(db: DataSource, roomId: string): Promise<number[]> {
  const rows = await db.getRepository<ChatParticipantEntity>('ChatParticipant').findBy({ roomId });
  return rows.map((row) => row.userId);
}

export async function listRooms(db: DataSource, user: SessionUser): Promise<ChatRoomDto[]> {
  const eventChatEnabled = (await readAppSettings(db, user.clubId)).features.eventChat;
  const rooms = await db.getRepository<ChatRoomEntity>('ChatRoom').find({
    where: { clubId: user.clubId, archivedAt: IsNull() },
    order: { updatedAt: 'DESC' },
  });
  const participants = rooms.length
    ? await db.getRepository<ChatParticipantEntity>('ChatParticipant').findBy({ roomId: In(rooms.map((room) => room.id)) })
    : [];
  const byRoom = new Map<string, number[]>();
  for (const participant of participants) {
    byRoom.set(participant.roomId, [...(byRoom.get(participant.roomId) ?? []), participant.userId]);
  }
  // Une seule lecture de la publication du club (au lieu d'une requête planning_records
  // par salon d'événement) : la visibilité de chaque salon se réduit à un test en mémoire.
  const eventKeys = eventChatEnabled && rooms.some((room) => room.type === 'event')
    ? await publishedEventKeys(db.manager, user.clubId)
    : new Set<string>();
  const eventAssignedByKey = new Map<string, number[]>();
  if (eventChatEnabled && rooms.some((room) => room.type === 'event')) {
    const published = await listPublishedPlanningEventSnapshots(db);
    if (published) {
      const hydrated = await hydratePlanningAssignmentStates(db, published, user.clubId);
      const activeUsers = await db.getRepository<UserEntity>('User').find({
        where: { active: true, clubId: user.clubId },
      });
      for (const snapshot of hydrated) {
        eventAssignedByKey.set(
          `${snapshot.eventType}:${snapshot.eventId}`,
          assignedUserIdsFromSnapshot(snapshot, activeUsers),
        );
      }
    }
  }
  const accessible: ChatRoomEntity[] = [];
  for (const room of rooms) {
    if (room.type === 'event' && !eventChatEnabled) continue;
    const eventAssigned = room.type === 'event' ? eventAssignedByKey.get(eventRoomKey(room)) ?? [] : [];
    if (!canAccessChatRoom(user, room, byRoom.get(room.id) ?? [], eventAssigned)) continue;
    if (room.type === 'event' && !eventKeys.has(eventRoomKey(room))) continue;
    accessible.push(room);
  }
  const allUserIds = Array.from(new Set(accessible.flatMap((room) => byRoom.get(room.id) ?? [])));
  const roomUsers = allUserIds.length
    ? await db.getRepository<UserEntity>('User').findBy({ id: In(allUserIds), clubId: user.clubId })
    : [];
  const userById = new Map(roomUsers.map((item) => [item.id, item]));
  const accessibleRoomIds = accessible.map((room) => room.id);
  // Dernier message et compteur de non-lus : une requête agrégée chacun, quel que soit
  // le nombre de salons (au lieu de 2 requêtes par salon).
  const [lastMessageByRoom, unreadByRoom] = await Promise.all([
    lastMessagesByRoom(db, accessibleRoomIds),
    unreadCountsByRoom(db, accessibleRoomIds, user.id),
  ]);
  const replyById = await replyPreviewMap(db, Array.from(lastMessageByRoom.values()));
  const lastReactionsById = await reactionSummariesForMessages(
    db,
    Array.from(lastMessageByRoom.values()).map((message) => message.id),
  );

  // Salons d'événement : logos des deux clubs (best-effort, une seule résolution).
  const eventLogosByKey = new Map<string, TeamLogoFields>();
  if (accessible.some((room) => room.type === 'event' && room.eventType && room.eventId)) {
    try {
      const [snapshots, resolveLogos] = await Promise.all([
        listPublishedPlanningEventSnapshots(db),
        createTeamLogoResolver(db, user.clubId),
      ]);
      const eventByKey = new Map<string, unknown>();
      for (const snapshot of snapshots ?? []) {
        eventByKey.set(`${snapshot.eventType}:${snapshot.eventId}`, (snapshot as { event?: unknown }).event);
      }
      for (const room of accessible) {
        if (room.type !== 'event' || !room.eventType || !room.eventId) continue;
        const key = `${room.eventType}:${room.eventId}`;
        const event = eventByKey.get(key) as Parameters<typeof resolveLogos>[0];
        eventLogosByKey.set(key, resolveLogos(event));
      }
    } catch (error) {
      console.error('Chat room logo enrichment failed:', error);
    }
  }

  return Promise.all(
    accessible.map(async (room) => {
      const ids = byRoom.get(room.id) ?? [];
      const roomParticipants = ids.flatMap((id) => {
        const item = userById.get(id);
        return item ? [{ id: item.id, nom: item.nom, accessRole: item.accessRole }] : [];
      });
      const last = lastMessageByRoom.get(room.id) ?? null;
      const unreadCount = unreadByRoom.get(room.id) ?? 0;
      const other = roomParticipants.find((participant) => participant.id !== user.id);
      return {
        id: room.id,
        type: room.type,
        name: room.type === 'direct' ? other?.nom ?? 'Conversation privée' : room.name ?? 'Salon',
        description: room.description,
        eventType: room.eventType,
        eventId: room.eventId,
        participants: roomParticipants,
        lastMessage: last ? messageDto(last, replyById, lastReactionsById.get(last.id) ?? []) : null,
        unreadCount,
        canManage: room.type === 'channel' && user.accessRole === 'admin',
        ...(room.type === 'event' && room.eventType && room.eventId
          ? eventLogosByKey.get(`${room.eventType}:${room.eventId}`) ?? {}
          : {}),
      };
    }),
  );
}
