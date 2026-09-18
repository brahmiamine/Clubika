import { logError, logWarn } from '@/lib/observability/log';
import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { onSessionRevocation, resolveClubSession, type SessionUser } from '@/lib/auth/session';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { getDb } from '@/lib/db';
import {
  appendMessage,
  assertRoomAccess,
  ChatAccessError,
  deleteMessage,
  ChatValidationError,
  listMessages,
  markRoomRead,
  participantIdsForRoom,
  toggleMessageReaction,
  type ChatMessageDto,
} from './service';
import { ChatProtocolError, parseDeleteCommand, parseMessageCommand, parseReactCommand, parseResumeCommand, parseTypingCommand } from './protocol';
import { handshakeClientAddress } from './socket-security';
import {
  isAllowedOriginUrl,
  requestHostOrigin,
  resolveBrowserOrigin,
} from '@/lib/security/request-origin';
import { notifyChatMessage, notifyChatReaction, chatMessagePreview } from './notifications';
import {
  acceptsSharedHandshake,
  acceptsSharedSlidingLimit,
  userActionBucketKey,
  userMessageBucketKey,
  userTypingBucketKey,
} from './socket-rate-limit';
import { setRealtimeHub, userRealtimeRoom } from '@/lib/realtime/hub';
import type { ChatReactionSummary } from './reactions';

interface ClientToServerEvents {
  'chat:resume': (
    command: unknown,
    acknowledge?: (result: { ok: true; messages: ChatMessageDto[] } | { ok: false; error: string }) => void,
  ) => void;
  'chat:send': (
    command: unknown,
    acknowledge?: (result: { ok: true; message: ChatMessageDto } | { ok: false; error: string }) => void,
  ) => void;
  'chat:read': (
    command: unknown,
    acknowledge?: (result: { ok: true } | { ok: false; error: string }) => void,
  ) => void;
  /**
   * Indicateur de frappe (issue #267) : signal éphémère, jamais persisté, sans accusé
   * (fire-and-forget) — un échec silencieux (accès refusé, limite atteinte) n'a pas
   * besoin d'être remonté au client, ce n'est qu'un indicateur de confort.
  */
  'chat:typing': (command: unknown) => void;
  /**
   * Supprime un message (contenu/pièce jointe purgés) : réservé à son auteur ou à un
   * administrateur du club (issue #259 pour la modération admin, issue #10 pour
   * l'auteur) — `deleteMessage` revérifie club/salon/accès/auteur côté serveur.
   */
  'chat:delete': (
    command: unknown,
    acknowledge?: (result: { ok: true; message: ChatMessageDto } | { ok: false; error: string }) => void,
  ) => void;
  'chat:react': (
    command: unknown,
    acknowledge?: (result: { ok: true; reactions: ChatReactionSummary[] } | { ok: false; error: string }) => void,
  ) => void;
}

interface ServerToClientEvents {
  'chat:message': (message: ChatMessageDto) => void;
  'chat:read': (receipt: { roomId: string; userId: number; sequence: number }) => void;
  /**
   * Signal léger (sans contenu) qu'un salon a reçu une activité — utilisé par la liste
   * des conversations (`ChatView`) pour rafraîchir sans que chaque socket connecté au
   * club n'ait à recevoir le contenu complet des messages d'événement.
   */
  'chat:room-touched': (touch: { roomId: string }) => void;
  /** Indicateur de frappe (issue #267) : relayé aux participants du salon, non persisté. */
  'chat:typing': (payload: { roomId: string; userId: number; nom: string }) => void;
  'chat:reaction': (payload: {
    roomId: string;
    messageId: string;
    reactions: ChatReactionSummary[];
    actorUserId: number;
    actorName: string;
    emoji: string;
    added: boolean;
    preview: string;
  }) => void;
  /** Une notification in-app a été créée ou marquée comme lue pour cet utilisateur. */
  'notifications:changed': () => void;
}

interface SocketData {
  user: SessionUser;
  sessionToken: string;
  sessionId: string;
}

export interface ChatSocketServerHandle {
  io: Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
  stopSessionRevocationListener: () => void;
}

function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function isAllowedOrigin(headers: Record<string, string | string[] | undefined>): boolean {
  const originHeader = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  const refererHeader = Array.isArray(headers.referer) ? headers.referer[0] : headers.referer;
  const resolved = resolveBrowserOrigin({ origin: originHeader, referer: refererHeader });
  if (!resolved.origin) return false;

  const forwardedHost = Array.isArray(headers['x-forwarded-host'])
    ? headers['x-forwarded-host'][0]
    : headers['x-forwarded-host'];
  const host = forwardedHost || (Array.isArray(headers.host) ? headers.host[0] : headers.host);
  const forwardedProto = Array.isArray(headers['x-forwarded-proto'])
    ? headers['x-forwarded-proto'][0]
    : headers['x-forwarded-proto'];
  const requestOrigin = requestHostOrigin({
    host,
    forwardedHost,
    forwardedProto,
  });
  return isAllowedOriginUrl(resolved.origin, requestOrigin);
}

function userSocketRoom(clubId: string, userId: number): string {
  return userRealtimeRoom(clubId, userId);
}

function clubSocketRoom(clubId: string): string {
  return `chat:club:${clubId}`;
}

/**
 * Salon socket dédié à un salon de discussion donné. Un socket ne le rejoint qu'après
 * avoir démontré un accès valide (résolution réussie de `chat:resume` pour ce salon) —
 * c'est sur ce canal, et non `clubSocketRoom`, que sont diffusés les messages et
 * accusés de lecture d'un salon d'événement : seuls les sockets ayant réellement
 * ouvert cette conversation les reçoivent, au lieu de tout le club connecté.
 */
function roomSocketRoom(roomId: string): string {
  return `chat:room:${roomId}`;
}

function publicSocketError(error: unknown, fallback: string): string {
  if (
    error instanceof ChatAccessError
    || error instanceof ChatValidationError
    || error instanceof ChatProtocolError
  ) {
    return error.message;
  }
  return fallback;
}

function acknowledgeSafely<T>(acknowledge: ((result: T) => void) | undefined, result: T): void {
  if (typeof acknowledge === 'function') acknowledge(result);
}

/**
 * Contrairement aux quotas d'upload de pièces jointes (`attachments.ts`), sérialisés par
 * verrou MariaDB `GET_LOCK` pour rester corrects même avec plusieurs instances Next,
 * les limites de débit du chat (handshake, actions, messages, frappe) sont persistées
 * en MariaDB via `chat_rate_limit_events` (issue #352) — voir socket-rate-limit.ts.
 *
 * Seul le compteur de connexions simultanées par utilisateur reste en mémoire locale
 * au pod (chaque socket vit sur l'instance qui l'a acceptée).
 *
 * Garde-fou : `CHAT_INSTANCE_COUNT` (optionnelle, défaut 1) documente le nombre d'instances
 * derrière le load balancer ; si > 1 sans migration 0020 appliquée, les limites partagées
 * ne fonctionnent pas — le log ci-dessous alerte l'opérateur.
 */
function warnIfMultiInstanceWithoutSharedRateLimits(): void {
  const raw = process.env.CHAT_INSTANCE_COUNT?.trim();
  if (!raw) return;
  const count = Number(raw);
  if (Number.isFinite(count) && count > 1) {
    logWarn('app.unhandled', 
      `[chat] CHAT_INSTANCE_COUNT=${raw} : les limites handshake/messages/actions sont partagées `
      + 'via MariaDB (migration 0020). Vérifiez que `pnpm db:migrate` a été exécuté sur toutes les instances.',
    );
  }
}

export function attachChatSocketServer(httpServer: HttpServer): ChatSocketServerHandle {
  warnIfMultiInstanceWithoutSharedRateLimits();
  const connectionCounts = new Map<number, number>();
  const TYPING_WINDOW_MS = 2_000;

  const acceptsWithinSharedLimit = async (
    bucketKey: string,
    maximum: number,
    windowMs = 10_000,
  ): Promise<boolean> => {
    const db = await getDb();
    return acceptsSharedSlidingLimit(db, bucketKey, maximum, windowMs);
  };

  const releaseConnection = (userId: number): void => {
    const nextCount = (connectionCounts.get(userId) ?? 1) - 1;
    if (nextCount > 0) connectionCounts.set(userId, nextCount);
    else connectionCounts.delete(userId);
  };

  const reserveConnection = (userId: number): boolean => {
    const nextCount = (connectionCounts.get(userId) ?? 0) + 1;
    if (nextCount > 8) return false;
    connectionCounts.set(userId, nextCount);
    return true;
  };

  const clearInactiveRateLimitEntries = (_userId: number): void => {
    // Les fenêtres glissantes partagées expirent côté MariaDB ; rien à purger localement.
  };

  const io = new Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
    path: '/socket.io',
    serveClient: false,
    maxHttpBufferSize: 32 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    allowRequest: (request, callback) => {
      const clientAddress = handshakeClientAddress(request.headers, request.socket.remoteAddress);
      void (async () => {
        try {
          const allowedOrigin = isAllowedOrigin(request.headers);
          if (!allowedOrigin) {
            callback(null, false);
            return;
          }
          const db = await getDb();
          const allowed = await acceptsSharedHandshake(db, clientAddress);
          callback(null, allowed);
        } catch {
          callback(null, false);
        }
      })();
    },
  });
  setRealtimeHub(io);

  io.use(async (socket, nextMiddleware) => {
    try {
      const token = cookieValue(socket.handshake.headers.cookie, SESSION_COOKIE_NAME);
      const resolved = await resolveClubSession(token);
      if (!resolved) return nextMiddleware(new Error('Non authentifié'));
      socket.data.user = resolved.user;
      socket.data.sessionToken = token!;
      socket.data.sessionId = resolved.session.id;
      nextMiddleware();
    } catch {
      nextMiddleware(new Error('Non authentifié'));
    }
  });

  io.on('connection', (socket) => {
    let user = socket.data.user;
    if (!reserveConnection(user.id)) {
      socket.disconnect(true);
      return;
    }
    void socket.join([userSocketRoom(user.clubId, user.id), clubSocketRoom(user.clubId)]);
    // Canaux `chat:room:*` rejoints par ce socket (voir chat:resume) : leur accès a été
    // vérifié pour le club courant, donc invalidé dès que celui-ci change.
    const joinedRoomChannels = new Set<string>();

    const revalidateSession = async () => {
      const active = await resolveClubSession(socket.data.sessionToken);
      const activeUser = active?.user;
      if (!activeUser || activeUser.id !== user.id) {
        socket.disconnect(true);
        throw new Error('Session expirée');
      }
      if (activeUser.clubId !== user.clubId) {
        await socket.leave(userSocketRoom(user.clubId, user.id));
        await socket.leave(clubSocketRoom(user.clubId));
        await socket.join(userSocketRoom(activeUser.clubId, activeUser.id));
        await socket.join(clubSocketRoom(activeUser.clubId));
        // Sans cela, un socket transféré vers un autre club continuerait de recevoir
        // les messages des salons d'événement de son ancien club (revue #288).
        for (const roomChannel of joinedRoomChannels) await socket.leave(roomChannel);
        joinedRoomChannels.clear();
      }
      user = activeUser;
      socket.data.user = activeUser;
      if (active) socket.data.sessionId = active.session.id;
      return activeUser;
    };
    const sessionCheck = setInterval(() => {
      void revalidateSession().catch(() => undefined);
    }, 15_000);

    socket.on('chat:resume', async (rawCommand, acknowledge) => {
      try {
        if (!(await acceptsWithinSharedLimit(userActionBucketKey(user.id), 60))) {
          throw new ChatProtocolError('Trop de requêtes, veuillez patienter');
        }
        await revalidateSession();
        setCurrentClubId(user.clubId);
        const command = parseResumeCommand(rawCommand);
        // Rejoint le canal dédié au salon AVANT de lire l'historique (et non après) :
        // un message envoyé par un autre participant entre les deux serait sinon à la
        // fois absent de l'instantané ci-dessous et émis avant que ce socket n'appartienne
        // au salon, donc invisible jusqu'à la prochaine reprise (revue #288). Si l'accès
        // s'avère refusé, on quitte aussitôt.
        const roomChannel = roomSocketRoom(command.roomId);
        await socket.join(roomChannel);
        joinedRoomChannels.add(roomChannel);
        let result;
        try {
          result = await listMessages(await getDb(), user, command.roomId, {
            afterSequence: command.afterSequence,
            limit: 200,
          });
        } catch (error) {
          await socket.leave(roomChannel);
          joinedRoomChannels.delete(roomChannel);
          throw error;
        }
        acknowledgeSafely(acknowledge, { ok: true, messages: result.messages });
      } catch (error) {
        acknowledgeSafely(acknowledge, { ok: false, error: publicSocketError(error, 'Reprise impossible') });
      }
    });

    socket.on('chat:send', async (rawCommand, acknowledge) => {
      try {
        if (!(await acceptsWithinSharedLimit(userActionBucketKey(user.id), 60))) {
          throw new ChatProtocolError('Trop de requêtes, veuillez patienter');
        }
        await revalidateSession();
        setCurrentClubId(user.clubId);
        if (!(await acceptsWithinSharedLimit(userMessageBucketKey(user.id), 20))) {
          throw new ChatProtocolError('Trop de messages, veuillez patienter');
        }
        const command = parseMessageCommand(rawCommand);
        const db = await getDb();
        const result = await appendMessage(db, user, command);
        if (!result.duplicate) {
          if (result.room.type === 'event') {
            // Contenu réservé aux sockets ayant ouvert ce salon (join sur `chat:resume`) ;
            // un signal sans contenu prévient tout le club pour rafraîchir la liste des
            // conversations (dernier message / non-lus) sans lui envoyer le message lui-même.
            io.to(roomSocketRoom(result.room.id)).emit('chat:message', result.message);
            io.to(clubSocketRoom(result.room.clubId)).emit('chat:room-touched', { roomId: result.room.id });
          } else {
            for (const participantUserId of result.participantUserIds) {
              io.to(userSocketRoom(result.room.clubId, participantUserId)).emit('chat:message', result.message);
            }
          }
        }
        acknowledgeSafely(acknowledge, { ok: true, message: result.message });
        if (!result.duplicate) {
          void notifyChatMessage(db, user, result, command.mentionedUserIds ?? []).catch((error) => {
            logError('app.unhandled', '[chat] Échec de notification après envoi :', error);
          });
        }
      } catch (error) {
        acknowledgeSafely(acknowledge, { ok: false, error: publicSocketError(error, 'Envoi impossible') });
      }
    });

    socket.on('chat:read', async (rawCommand, acknowledge) => {
      try {
        if (!(await acceptsWithinSharedLimit(userActionBucketKey(user.id), 60))) {
          throw new ChatProtocolError('Trop de requêtes, veuillez patienter');
        }
        await revalidateSession();
        setCurrentClubId(user.clubId);
        const command = parseResumeCommand(rawCommand);
        const { room } = await markRoomRead(await getDb(), user, command.roomId, command.afterSequence);
        const receipt = { roomId: room.id, userId: user.id, sequence: command.afterSequence };
        if (room.type === 'event') {
          // Qui a lu quoi dans un salon d'événement ne regarde que les sockets ayant
          // ouvert ce salon, pas tout le club.
          io.to(roomSocketRoom(room.id)).emit('chat:read', receipt);
        } else {
          for (const participantUserId of await participantIdsForRoom(await getDb(), room.id)) {
            io.to(userSocketRoom(room.clubId, participantUserId)).emit('chat:read', receipt);
          }
        }
        // Le lecteur doit toujours recevoir l'accusé sur son canal utilisateur : le
        // badge Chat (hors page de conversation) n'est pas dans `chat:room:*`.
        io.to(userSocketRoom(user.clubId, user.id)).emit('chat:read', receipt);
        acknowledgeSafely(acknowledge, { ok: true });
      } catch (error) {
        acknowledgeSafely(acknowledge, { ok: false, error: publicSocketError(error, 'Marquage lu impossible') });
      }
    });

    // Indicateur de frappe (issue #267) : signal éphémère, sans accusé, jamais persisté.
    // Un échec (limite atteinte, accès refusé) est ignoré silencieusement — ce n'est
    // qu'un indicateur de confort, pas une action dont l'utilisateur attend un résultat.
    socket.on('chat:typing', async (rawCommand) => {
      try {
        if (!(await acceptsWithinSharedLimit(userTypingBucketKey(user.id), 1, TYPING_WINDOW_MS))) return;
        await revalidateSession();
        setCurrentClubId(user.clubId);
        const command = parseTypingCommand(rawCommand);
        const room = await assertRoomAccess(await getDb(), user, command.roomId);
        const payload = { roomId: room.id, userId: user.id, nom: user.nom };
        if (room.type === 'event') {
          // `socket.to` (et non `io.to`) exclut automatiquement l'émetteur du salon.
          socket.to(roomSocketRoom(room.id)).emit('chat:typing', payload);
        } else {
          for (const participantUserId of await participantIdsForRoom(await getDb(), room.id)) {
            if (participantUserId === user.id) continue;
            io.to(userSocketRoom(room.clubId, participantUserId)).emit('chat:typing', payload);
          }
        }
      } catch {
        // Signal éphémère : aucune erreur remontée au client.
      }
    });

    socket.on('chat:delete', async (rawCommand, acknowledge) => {
      try {
        if (!(await acceptsWithinSharedLimit(userActionBucketKey(user.id), 60))) {
          throw new ChatProtocolError('Trop de requêtes, veuillez patienter');
        }
        await revalidateSession();
        setCurrentClubId(user.clubId);
        const command = parseDeleteCommand(rawCommand);
        const result = await deleteMessage(await getDb(), user, command.roomId, command.messageId);
        // Même ciblage que chat:send : le message (désormais vidé, deletedAt renseigné)
        // remplace l'original chez chaque destinataire via la fusion par id côté client.
        if (result.room.type === 'event') {
          io.to(roomSocketRoom(result.room.id)).emit('chat:message', result.message);
          io.to(clubSocketRoom(result.room.clubId)).emit('chat:room-touched', { roomId: result.room.id });
        } else {
          for (const participantUserId of result.participantUserIds) {
            io.to(userSocketRoom(result.room.clubId, participantUserId)).emit('chat:message', result.message);
          }
        }
        acknowledgeSafely(acknowledge, { ok: true, message: result.message });
      } catch (error) {
        acknowledgeSafely(acknowledge, { ok: false, error: publicSocketError(error, 'Suppression impossible') });
      }
    });

    socket.on('chat:react', async (rawCommand, acknowledge) => {
      try {
        if (!(await acceptsWithinSharedLimit(userActionBucketKey(user.id), 60))) {
          throw new ChatProtocolError('Trop de requêtes, veuillez patienter');
        }
        await revalidateSession();
        setCurrentClubId(user.clubId);
        const command = parseReactCommand(rawCommand);
        const db = await getDb();
        const result = await toggleMessageReaction(db, user, command.roomId, command.messageId, command.emoji);
        const payload = {
          roomId: result.room.id,
          messageId: result.messageId,
          reactions: result.reactions,
          actorUserId: user.id,
          actorName: user.nom,
          emoji: command.emoji,
          added: result.added,
          preview: chatMessagePreview(result.message),
        };
        if (result.room.type === 'event') {
          io.to(roomSocketRoom(result.room.id)).emit('chat:reaction', payload);
        } else {
          for (const participantUserId of result.participantUserIds) {
            io.to(userSocketRoom(result.room.clubId, participantUserId)).emit('chat:reaction', payload);
          }
        }
        acknowledgeSafely(acknowledge, { ok: true, reactions: result.reactions });
        if (result.added) {
          void notifyChatReaction(db, user, result, command.emoji).catch((error) => {
            logError('app.unhandled', '[chat] Échec de notification après réaction :', error);
          });
        }
      } catch (error) {
        acknowledgeSafely(acknowledge, { ok: false, error: publicSocketError(error, 'Réaction impossible') });
      }
    });

    socket.on('disconnect', () => {
      clearInterval(sessionCheck);
      releaseConnection(user.id);
      clearInactiveRateLimitEntries(user.id);
    });
  });

  const stopSessionRevocationListener = onSessionRevocation((event) => {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.user.id !== event.userId) continue;
      if (event.exceptSessionId && socket.data.sessionId === event.exceptSessionId) continue;
      if (event.sessionId && socket.data.sessionId !== event.sessionId) continue;
      if (event.sessionToken && socket.data.sessionToken !== event.sessionToken) continue;
      socket.disconnect(true);
    }
  });

  return { io, stopSessionRevocationListener };
}
