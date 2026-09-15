import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as createClient, type Socket } from 'socket.io-client';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { getSessionUser } from '@/lib/auth/session';
import { SESSION_COOKIE_NAME } from '@/lib/auth/constants';
import { runWithClubId } from '@/lib/auth/club-context';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { savePlanningRecord } from '@/lib/planning/records';
import { createChannel, getOrCreateEventRoom, type ChatMessageDto } from './service';
import { attachChatSocketServer } from './socket-server';

async function waitForDatabase(): Promise<boolean> {
  const attempts = process.env.CI ? 10 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isDbAvailable()) return true;
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return false;
}

const dbAvailable = await waitForDatabase();
if (process.env.CI && !dbAvailable) {
  throw new Error('MariaDB is required for the Socket.IO integration test in CI');
}

interface SendAcknowledgement {
  ok: boolean;
  error?: string;
  message?: ChatMessageDto;
}

function connectClient(origin: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createClient(origin, {
      autoConnect: false,
      path: '/socket.io',
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: {
        Cookie: `${SESSION_COOKIE_NAME}=${token}`,
        Origin: origin,
      },
    });
    const timeout = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket.IO connection timeout'));
    }, 5_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.connect();
  });
}

describe.skipIf(!dbAvailable)('Socket.IO chat integration', () => {
  const sockets: Socket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  it('persists one message and broadcasts it to a second authenticated client', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    const db = await getDb();
    const adminSession = await getSessionUser(admin.token);
    expect(adminSession).not.toBeNull();
    const room = await createChannel(db, adminSession!, { name: 'Socket E2E' }, [member.user.id]);
    const httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const socketServer = attachChatSocketServer(httpServer);

    try {
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const [sender, receiver] = await Promise.all([
        connectClient(origin, admin.token),
        connectClient(origin, member.token),
      ]);
      sockets.push(sender, receiver);

      const received = new Promise<ChatMessageDto>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Message broadcast timeout')), 5_000);
        receiver.once('chat:message', (message: ChatMessageDto) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });

      const command = {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440001',
        content: 'Message Socket.IO persistant',
      };
      const acknowledgement = await new Promise<SendAcknowledgement>((resolve) => {
        sender.emit('chat:send', command, resolve);
      });
      const broadcast = await received;

      expect(acknowledgement.ok).toBe(true);
      expect(acknowledgement.message?.id).toBe(broadcast.id);
      expect(broadcast.content).toBe(command.content);
      const persisted = await db.getRepository('ChatMessage').findBy({ roomId: room.id });
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.content).toBe(command.content);
      expect(persisted[0]?.sequence).toBe(1);
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await db.getRepository('ChatReadState').delete({ roomId: room.id });
      await db.getRepository('ChatMessage').delete({ roomId: room.id });
      await db.getRepository('ChatParticipant').delete({ roomId: room.id });
      await db.getRepository('ChatRoom').delete({ id: room.id });
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('relays chat:typing to the other room participant only, without persisting anything (issue #267)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    const db = await getDb();
    const adminSession = await getSessionUser(admin.token);
    const room = await createChannel(db, adminSession!, { name: 'Frappe' }, [member.user.id]);
    const httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const socketServer = attachChatSocketServer(httpServer);

    try {
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const [sender, receiver] = await Promise.all([
        connectClient(origin, admin.token),
        connectClient(origin, member.token),
      ]);
      sockets.push(sender, receiver);

      const received = new Promise<{ roomId: string; userId: number; nom: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Typing broadcast timeout')), 5_000);
        receiver.once('chat:typing', (payload: { roomId: string; userId: number; nom: string }) => {
          clearTimeout(timeout);
          resolve(payload);
        });
      });
      let senderReceivedOwnTyping = false;
      sender.once('chat:typing', () => { senderReceivedOwnTyping = true; });

      sender.emit('chat:typing', { roomId: room.id });

      const payload = await received;
      expect(payload.roomId).toBe(room.id);
      expect(payload.userId).toBe(admin.user.id);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(senderReceivedOwnTyping).toBe(false);

      // Signal éphémère : rien n'est écrit en base (ni chat_messages, ni ailleurs).
      const persisted = await db.getRepository('ChatMessage').findBy({ roomId: room.id });
      expect(persisted).toHaveLength(0);
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await db.getRepository('ChatReadState').delete({ roomId: room.id });
      await db.getRepository('ChatMessage').delete({ roomId: room.id });
      await db.getRepository('ChatParticipant').delete({ roomId: room.id });
      await db.getRepository('ChatRoom').delete({ id: room.id });
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('lets an admin delete a message over chat:delete; the emptied message is broadcast (issue #259)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    const db = await getDb();
    const adminSession = await getSessionUser(admin.token);
    const room = await createChannel(db, adminSession!, { name: 'Modération Socket' }, [member.user.id]);
    const httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const socketServer = attachChatSocketServer(httpServer);

    try {
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const [adminSocket, memberSocket] = await Promise.all([
        connectClient(origin, admin.token),
        connectClient(origin, member.token),
      ]);
      sockets.push(adminSocket, memberSocket);

      const command = {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440077',
        content: 'À supprimer',
      };
      const memberReceivedOriginal = new Promise<ChatMessageDto>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Original broadcast timeout')), 5_000);
        memberSocket.once('chat:message', (message: ChatMessageDto) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
      const sendAck = await new Promise<SendAcknowledgement>((resolve) => {
        adminSocket.emit('chat:send', command, resolve);
      });
      expect(sendAck.ok).toBe(true);
      const messageId = sendAck.message!.id;

      const original = await memberReceivedOriginal;
      expect(original.id).toBe(messageId);
      expect(original.content).toBe('À supprimer');

      const memberReceivedDeletion = new Promise<ChatMessageDto>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Deletion broadcast timeout')), 5_000);
        memberSocket.once('chat:message', (message: ChatMessageDto) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });

      const deleteAck = await new Promise<SendAcknowledgement>((resolve) => {
        adminSocket.emit('chat:delete', { roomId: room.id, messageId }, resolve);
      });
      expect(deleteAck.ok).toBe(true);
      expect(deleteAck.message?.content).toBe('');
      expect(deleteAck.message?.deletedAt).not.toBeNull();

      const broadcast = await memberReceivedDeletion;
      expect(broadcast.id).toBe(messageId);
      expect(broadcast.content).toBe('');
      expect(broadcast.deletedAt).not.toBeNull();

      const persisted = await db.getRepository('ChatMessage').findOneBy({ id: messageId });
      expect(persisted?.content).toBe('');
      expect(persisted?.deletedAt).not.toBeNull();
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await db.getRepository('ChatReadState').delete({ roomId: room.id });
      await db.getRepository('ChatMessage').delete({ roomId: room.id });
      await db.getRepository('ChatParticipant').delete({ roomId: room.id });
      await db.getRepository('ChatRoom').delete({ id: room.id });
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('rejects chat:delete from a non-admin without persisting any change', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    const db = await getDb();
    const adminSession = await getSessionUser(admin.token);
    const room = await createChannel(db, adminSession!, { name: 'Modération refusée' }, [member.user.id]);
    const httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const socketServer = attachChatSocketServer(httpServer);

    try {
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const [adminSocket, memberSocket] = await Promise.all([
        connectClient(origin, admin.token),
        connectClient(origin, member.token),
      ]);
      sockets.push(adminSocket, memberSocket);

      const sendAck = await new Promise<SendAcknowledgement>((resolve) => {
        adminSocket.emit('chat:send', { roomId: room.id, clientMessageId: '550e8400-e29b-41d4-a716-446655440078', content: 'Reste' }, resolve);
      });
      const messageId = sendAck.message!.id;

      const deleteAck = await new Promise<SendAcknowledgement>((resolve) => {
        memberSocket.emit('chat:delete', { roomId: room.id, messageId }, resolve);
      });
      expect(deleteAck.ok).toBe(false);

      const persisted = await db.getRepository('ChatMessage').findOneBy({ id: messageId });
      expect(persisted?.content).toBe('Reste');
      expect(persisted?.deletedAt).toBeNull();
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await db.getRepository('ChatReadState').delete({ roomId: room.id });
      await db.getRepository('ChatMessage').delete({ roomId: room.id });
      await db.getRepository('ChatParticipant').delete({ roomId: room.id });
      await db.getRepository('ChatRoom').delete({ id: room.id });
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('scopes an event room message to sockets that opened that room, not the whole club', async () => {
    // Club dédié (et non le clubId 'afp' partagé par la quasi-totalité de la suite) :
    // ce test écrit `published-planning:${clubId}`, une ligne unique par club, et une
    // course avec un autre fichier de test exécuté en parallèle sur le même clubId
    // pouvait la réécrire entre l'écriture et la lecture faite par `chat:resume`,
    // provoquant une erreur « Cet événement n'est plus publié » intermittente en CI.
    const clubId = `chat-event-room-scope-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const viewer = await createTestUserAndSession('dirigeant', { clubId }, ['arbitre_club']);
    const bystander = await createTestUserAndSession('dirigeant', { clubId }, ['arbitre_club']);
    const db = await getDb();
    const eventId = `chat-event-socket-${Date.now()}`;
    const httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const socketServer = attachChatSocketServer(httpServer);
    let roomId: string | null = null;

    try {
      await db.getRepository('MatchOfficial').save({
        id: eventId,
        clubId,
        date: '20/08/2026',
        time: '18:00',
        payload: {
          id: eventId,
          type: 'officiel',
          date: '20/08/2026',
          time: '18:00',
          horaireRendezVous: '17:00',
          competition: 'Championnat',
          localTeam: 'AFP',
          awayTeam: 'Visiteur',
          venue: 'domicile',
        },
      });
      await db.getRepository('MatchExtra').save({
        matchId: eventId,
        clubId,
        payload: { id: eventId, planningStatus: 'published' },
      });
      await runWithClubId(clubId, () => savePlanningRecord(db, {
        id: `published-planning:${clubId}`,
        clubId,
        kind: 'published-planning',
        payload: {
          schemaVersion: 1,
          publishedAt: new Date().toISOString(),
          publishedByUserId: admin.user.id,
          events: [{
            eventId,
            eventType: 'officiel',
            title: 'AFP – Visiteur',
            date: '20/08/2026',
            time: '18:00',
            durationMinutes: 90,
            location: null,
            planningStatus: 'published',
            event: {
              id: eventId,
              type: 'officiel',
              date: '20/08/2026',
              time: '18:00',
              horaireRendezVous: '17:00',
              competition: 'Championnat',
              localTeam: 'AFP',
              awayTeam: 'Visiteur',
              venue: 'domicile',
            },
            extras: { id: eventId, planningStatus: 'published' },
            assignments: {
              arbitre: [{
                nom: viewer.user.nom,
                numero: '',
                personId: viewer.user.id,
                personType: 'officiel',
                status: 'accepted',
              }],
              encadrant: [],
              accompagnateur: [],
            },
          }],
        },
      }));

      const adminSession = await getSessionUser(admin.token);
      const room = await runWithClubId(clubId, () => getOrCreateEventRoom(db, adminSession!, 'officiel', eventId));
      roomId = room.id;

      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const [sender, viewerSocket, bystanderSocket] = await Promise.all([
        connectClient(origin, admin.token),
        connectClient(origin, viewer.token),
        connectClient(origin, bystander.token),
      ]);
      sockets.push(sender, viewerSocket, bystanderSocket);

      // Le viewer ouvre le salon (comme ChatConversation au montage) : le serveur le fait
      // rejoindre le canal socket dédié à ce salon après avoir vérifié son accès.
      await new Promise<void>((resolve, reject) => {
        viewerSocket.emit('chat:resume', { roomId: room.id, afterSequence: 0 }, (result: { ok: boolean; error?: string }) => {
          if (!result.ok) reject(new Error(result.error));
          else resolve();
        });
      });

      const viewerReceived = new Promise<ChatMessageDto>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('viewer message timeout')), 5_000);
        viewerSocket.once('chat:message', (message: ChatMessageDto) => {
          clearTimeout(timeout);
          resolve(message);
        });
      });
      const bystanderTouched = new Promise<{ roomId: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('room-touched timeout')), 5_000);
        bystanderSocket.once('chat:room-touched', (touch: { roomId: string }) => {
          clearTimeout(timeout);
          resolve(touch);
        });
      });
      let bystanderReceivedFullMessage = false;
      bystanderSocket.once('chat:message', () => { bystanderReceivedFullMessage = true; });

      const command = {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440099',
        content: 'Message événement ciblé',
      };
      const acknowledgement = await new Promise<SendAcknowledgement>((resolve) => {
        sender.emit('chat:send', command, resolve);
      });
      expect(acknowledgement.ok).toBe(true);

      const viewerMessage = await viewerReceived;
      expect(viewerMessage.content).toBe(command.content);

      const touch = await bystanderTouched;
      expect(touch.roomId).toBe(room.id);

      // Laisse le temps à un éventuel envoi club-wide (régression) d'arriver.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(bystanderReceivedFullMessage).toBe(false);
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (roomId) {
        await db.getRepository('ChatReadState').delete({ roomId });
        await db.getRepository('ChatMessage').delete({ roomId });
        await db.getRepository('ChatRoom').delete({ id: roomId });
      }
      await db.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [`published-planning:${clubId}`, clubId]);
      await db.getRepository('MatchExtra').delete({ matchId: eventId, clubId });
      await db.getRepository('MatchOfficial').delete({ id: eventId, clubId });
      await admin.cleanup();
      await viewer.cleanup();
      await bystander.cleanup();
    }
  });

  it('rejects chat:send from a user in club A to a room in club B (issue #346)', async () => {
    const clubA = `chat-cross-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `chat-cross-club-b-${randomBytes(6).toString('hex')}`;
    const userA = await createTestUserAndSession('admin', { clubId: clubA });
    const adminB = await createTestUserAndSession('admin', { clubId: clubB });
    const db = await getDb();
    const adminBSession = await getSessionUser(adminB.token);
    expect(adminBSession).not.toBeNull();
    const roomB = await createChannel(db, adminBSession!, { name: 'Salon club B' }, []);
    const httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const socketServer = attachChatSocketServer(httpServer);

    try {
      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const attackerSocket = await connectClient(origin, userA.token);
      sockets.push(attackerSocket);

      const acknowledgement = await new Promise<SendAcknowledgement>((resolve) => {
        attackerSocket.emit('chat:send', {
          roomId: roomB.id,
          clientMessageId: '550e8400-e29b-41d4-a716-446655440346',
          content: 'Tentative cross-club',
        }, resolve);
      });

      expect(acknowledgement.ok).toBe(false);
      const persisted = await db.getRepository('ChatMessage').findBy({ roomId: roomB.id });
      expect(persisted).toHaveLength(0);
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await db.getRepository('ChatReadState').delete({ roomId: roomB.id });
      await db.getRepository('ChatMessage').delete({ roomId: roomB.id });
      await db.getRepository('ChatParticipant').delete({ roomId: roomB.id });
      await db.getRepository('ChatRoom').delete({ id: roomB.id });
      await userA.cleanup();
      await adminB.cleanup();
    }
  });

  it('stops delivering an event room\'s messages to a socket once its user changes club', async () => {
    // Club dédié pour la même raison que le test précédent : éviter la course sur la
    // ligne partagée `published-planning:afp` avec d'autres suites exécutées en parallèle.
    const clubId = `chat-event-room-club-switch-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const viewer = await createTestUserAndSession('dirigeant', { clubId }, ['arbitre_club']);
    const db = await getDb();
    const eventId = `chat-event-club-switch-${Date.now()}`;
    const httpServer = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const socketServer = attachChatSocketServer(httpServer);
    let roomId: string | null = null;

    try {
      await db.getRepository('MatchOfficial').save({
        id: eventId,
        clubId,
        date: '20/08/2026',
        time: '18:00',
        payload: {
          id: eventId,
          type: 'officiel',
          date: '20/08/2026',
          time: '18:00',
          horaireRendezVous: '17:00',
          competition: 'Championnat',
          localTeam: 'AFP',
          awayTeam: 'Visiteur',
          venue: 'domicile',
        },
      });
      await db.getRepository('MatchExtra').save({
        matchId: eventId,
        clubId,
        payload: { id: eventId, planningStatus: 'published' },
      });
      await runWithClubId(clubId, () => savePlanningRecord(db, {
        id: `published-planning:${clubId}`,
        clubId,
        kind: 'published-planning',
        payload: {
          schemaVersion: 1,
          publishedAt: new Date().toISOString(),
          publishedByUserId: admin.user.id,
          events: [{
            eventId,
            eventType: 'officiel',
            title: 'AFP – Visiteur',
            date: '20/08/2026',
            time: '18:00',
            durationMinutes: 90,
            location: null,
            planningStatus: 'published',
            event: {
              id: eventId,
              type: 'officiel',
              date: '20/08/2026',
              time: '18:00',
              horaireRendezVous: '17:00',
              competition: 'Championnat',
              localTeam: 'AFP',
              awayTeam: 'Visiteur',
              venue: 'domicile',
            },
            extras: { id: eventId, planningStatus: 'published' },
            assignments: {
              arbitre: [{
                nom: viewer.user.nom,
                numero: '',
                personId: viewer.user.id,
                personType: 'officiel',
                status: 'accepted',
              }],
              encadrant: [],
              accompagnateur: [],
            },
          }],
        },
      }));

      const adminSession = await getSessionUser(admin.token);
      const room = await runWithClubId(clubId, () => getOrCreateEventRoom(db, adminSession!, 'officiel', eventId));
      roomId = room.id;

      await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
      const address = httpServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const [sender, viewerSocket] = await Promise.all([
        connectClient(origin, admin.token),
        connectClient(origin, viewer.token),
      ]);
      sockets.push(sender, viewerSocket);

      // Le viewer ouvre le salon d'événement de son club et rejoint donc son canal socket.
      await new Promise<void>((resolve, reject) => {
        viewerSocket.emit('chat:resume', { roomId: room.id, afterSequence: 0 }, (result: { ok: boolean; error?: string }) => {
          if (!result.ok) reject(new Error(result.error));
          else resolve();
        });
      });

      // Le viewer est transféré vers un autre club (ex. changement d'affectation) ; la
      // prochaine action socket revalide la session et doit lui faire quitter le canal
      // de l'ancien club — sans quoi il continuerait de recevoir ses messages (revue #288).
      await db.getRepository('User').update({ id: viewer.user.id }, { clubId: 'other' });
      await new Promise<void>((resolve) => {
        viewerSocket.emit('chat:read', { roomId: room.id, afterSequence: 0 }, () => resolve());
      });

      let viewerReceivedMessage = false;
      viewerSocket.once('chat:message', () => { viewerReceivedMessage = true; });

      const command = {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440077',
        content: 'Message après changement de club',
      };
      const acknowledgement = await new Promise<SendAcknowledgement>((resolve) => {
        sender.emit('chat:send', command, resolve);
      });
      expect(acknowledgement.ok).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(viewerReceivedMessage).toBe(false);
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (roomId) {
        await db.getRepository('ChatReadState').delete({ roomId });
        await db.getRepository('ChatMessage').delete({ roomId });
        await db.getRepository('ChatRoom').delete({ id: roomId });
      }
      await db.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [`published-planning:${clubId}`, clubId]);
      await db.getRepository('MatchExtra').delete({ matchId: eventId, clubId });
      await db.getRepository('MatchOfficial').delete({ id: eventId, clubId });
      await admin.cleanup();
      await viewer.cleanup();
    }
  });

  it('refuse une connexion WebSocket d’origine tierce', async () => {
    const user = await createTestUserAndSession('dirigeant', { clubId: 'afp' });
    const httpServer = createServer();
    const socketServer = attachChatSocketServer(httpServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      await expect(new Promise<void>((resolve, reject) => {
        const socket = createClient(origin, {
          autoConnect: false,
          path: '/socket.io',
          transports: ['websocket'],
          reconnection: false,
          extraHeaders: {
            Cookie: `${SESSION_COOKIE_NAME}=${user.token}`,
            Origin: 'https://evil.example',
          },
        });
        const timeout = setTimeout(() => {
          socket.disconnect();
          reject(new Error('expected cross-origin handshake to fail'));
        }, 5_000);
        socket.once('connect', () => {
          clearTimeout(timeout);
          socket.disconnect();
          reject(new Error('cross-origin socket connected'));
        });
        socket.once('connect_error', () => {
          clearTimeout(timeout);
          socket.disconnect();
          resolve();
        });
        socket.connect();
      })).resolves.toBeUndefined();
    } finally {
      socketServer.stopSessionRevocationListener();
      await new Promise<void>((resolve) => socketServer.io.close(() => resolve()));
      if (httpServer.listening) await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await user.cleanup();
    }
  });
});
