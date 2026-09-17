import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { getSessionUser } from '@/lib/auth/session';
import { runWithClubId } from '@/lib/auth/club-context';
import { savePlanningRecord } from '@/lib/planning/records';
import {
  anonymizeMessagesForDeletedUser,
  ANONYMIZED_SENDER_NAME,
  appendMessage,
  archiveChannel,
  assertRoomAccess,
  ChatAccessError,
  ChatValidationError,
  createChannel,
  deleteMessage,
  getOrCreateEventRoom,
  listMessages,
  listRooms,
  toggleMessageReaction,
} from './service';
import { getChatAttachment, saveChatAttachment } from './attachments';

const dbAvailable = await isDbAvailable();

describe.skipIf(!dbAvailable)('chat service integration', () => {
  const roomIds: string[] = [];

  afterEach(async () => {
    if (roomIds.length === 0) return;
    const db = await getDb();
    await db.query(
      `DELETE FROM chat_message_reactions WHERE messageId IN (SELECT id FROM chat_messages WHERE roomId IN (${roomIds.map(() => '?').join(',')}))`,
      roomIds,
    );
    await db.getRepository('ChatReadState').createQueryBuilder().delete().where('roomId IN (:...ids)', { ids: roomIds }).execute();
    await db.getRepository('ChatMessage').createQueryBuilder().delete().where('roomId IN (:...ids)', { ids: roomIds }).execute();
    await db.getRepository('ChatParticipant').createQueryBuilder().delete().where('roomId IN (:...ids)', { ids: roomIds }).execute();
    await db.getRepository('ChatRoom').createQueryBuilder().delete().where('id IN (:...ids)', { ids: roomIds }).execute();
    roomIds.length = 0;
  });

  it('applies a retried message exactly once', async () => {
    const first = await createTestUserAndSession('admin', { clubId: 'afp' });
    const second = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const firstSession = await getSessionUser(first.token);
      const secondSession = await getSessionUser(second.token);
      expect(firstSession).not.toBeNull();
      expect(secondSession).not.toBeNull();
      const room = await createChannel(await getDb(), firstSession!, { name: 'Opérations' }, [second.user.id]);
      roomIds.push(room.id);
      const command = {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440000',
        content: 'Message unique',
        attachment: null,
        replyToMessageId: null,
        forwardSourceMessageId: null,
      };

      const initial = await appendMessage(await getDb(), firstSession!, command);
      const retry = await appendMessage(await getDb(), firstSession!, command);
      const history = await listMessages(await getDb(), secondSession!, room.id);

      expect(initial.duplicate).toBe(false);
      expect(retry.duplicate).toBe(true);
      expect(retry.message.id).toBe(initial.message.id);
      expect(history.messages).toHaveLength(1);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it('paginates message history backwards with beforeSequence', async () => {
    const first = await createTestUserAndSession('admin', { clubId: 'afp' });
    const second = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const firstSession = await getSessionUser(first.token);
      const secondSession = await getSessionUser(second.token);
      const room = await createChannel(await getDb(), firstSession!, { name: 'Historique' }, [second.user.id]);
      roomIds.push(room.id);

      const total = 5;
      for (let i = 0; i < total; i += 1) {
        await appendMessage(await getDb(), firstSession!, {
          roomId: room.id,
          clientMessageId: `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}`,
          content: `Message ${i}`,
          attachment: null,
          replyToMessageId: null,
          forwardSourceMessageId: null,
        });
      }

      const firstPage = await listMessages(await getDb(), secondSession!, room.id, { limit: 2 });
      expect(firstPage.messages.map((m) => m.content)).toEqual(['Message 3', 'Message 4']);
      expect(firstPage.hasMoreBefore).toBe(true);

      const oldestOfFirstPage = firstPage.messages[0]!.sequence;
      const secondPage = await listMessages(await getDb(), secondSession!, room.id, {
        beforeSequence: oldestOfFirstPage,
        limit: 2,
      });
      expect(secondPage.messages.map((m) => m.content)).toEqual(['Message 1', 'Message 2']);
      expect(secondPage.hasMoreBefore).toBe(true);

      const thirdPage = await listMessages(await getDb(), secondSession!, room.id, {
        beforeSequence: secondPage.messages[0]!.sequence,
        limit: 2,
      });
      expect(thirdPage.messages.map((m) => m.content)).toEqual(['Message 0']);
      expect(thirdPage.hasMoreBefore).toBe(false);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it('never returns more than `limit` messages on forward pagination (afterSequence)', async () => {
    // Régression : la borne « une page de plus pour détecter hasMoreBefore » ne doit
    // s'appliquer qu'au chargement DESC (initial / beforeSequence), jamais à la reprise
    // ASC (afterSequence) — sinon resumeFrom (ChatConversation) reçoit systématiquement
    // limit+1 lignes, ne remplit jamais sa condition `=== limit` et arrête la pagination.
    const first = await createTestUserAndSession('admin', { clubId: 'afp' });
    const second = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const firstSession = await getSessionUser(first.token);
      const secondSession = await getSessionUser(second.token);
      const room = await createChannel(await getDb(), firstSession!, { name: 'Reprise' }, [second.user.id]);
      roomIds.push(room.id);

      const total = 5;
      let firstMessageSequence = 0;
      for (let i = 0; i < total; i += 1) {
        const appended = await appendMessage(await getDb(), firstSession!, {
          roomId: room.id,
          clientMessageId: `550e8400-e29b-41d4-a716-4466554401${String(i).padStart(2, '0')}`,
          content: `Reprise ${i}`,
          attachment: null,
          replyToMessageId: null,
          forwardSourceMessageId: null,
        });
        if (i === 0) firstMessageSequence = appended.message.sequence;
      }

      // Reprend juste après le tout premier message (afterSequence: 0, lui, est équivalent
      // à « pas de curseur » et renverrait la dernière page — voir listMessages).
      const resumed = await listMessages(await getDb(), secondSession!, room.id, {
        afterSequence: firstMessageSequence,
        limit: 2,
      });
      expect(resumed.messages).toHaveLength(2);
      expect(resumed.messages.map((m) => m.content)).toEqual(['Reprise 1', 'Reprise 2']);

      const nextSequence = resumed.messages.at(-1)!.sequence;
      const nextPage = await listMessages(await getDb(), secondSession!, room.id, { afterSequence: nextSequence, limit: 2 });
      expect(nextPage.messages).toHaveLength(2);
      expect(nextPage.messages.map((m) => m.content)).toEqual(['Reprise 3', 'Reprise 4']);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });

  it('lists rooms with a bounded number of raw queries, independent of the room count', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const db = await getDb();

      const rooms = await Promise.all(
        Array.from({ length: 4 }, (_, index) => createChannel(db, adminSession!, { name: `Salon ${index}` }, [member.user.id])),
      );
      for (const room of rooms) roomIds.push(room.id);
      for (const [index, room] of rooms.entries()) {
        await appendMessage(db, adminSession!, {
          roomId: room.id,
          clientMessageId: `550e8400-e29b-41d4-a716-44665544${String(index).padStart(4, '0')}`,
          content: `Message dans ${room.name}`,
          attachment: null,
          replyToMessageId: null,
          forwardSourceMessageId: null,
        });
      }

      const querySpy = vi.spyOn(db.manager, 'query');
      const dtos = await listRooms(db, memberSession!);
      const queriesForFourRooms = querySpy.mock.calls.length;
      querySpy.mockRestore();

      expect(dtos.filter((dto) => rooms.some((room) => room.id === dto.id))).toHaveLength(4);
      for (const dto of dtos) {
        const room = rooms.find((item) => item.id === dto.id);
        if (!room) continue;
        expect(dto.lastMessage?.content).toBe(`Message dans ${room.name}`);
        expect(dto.unreadCount).toBe(1);
      }
      // Deux requêtes agrégées (dernier message + non-lus), quel que soit le nombre de
      // salons — avant #256, c'était 2 requêtes PAR salon (N+1).
      expect(queriesForFourRooms).toBe(2);
    } finally {
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('rejects a channel participant from another club', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const outsider = await createTestUserAndSession('dirigeant', { clubId: 'other' }, ['arbitre_club']);
    try {
      const adminSession = await getSessionUser(admin.token);
      const outsiderSession = await getSessionUser(outsider.token);
      const room = await createChannel(await getDb(), adminSession!, { name: 'Club AFP' }, []);
      roomIds.push(room.id);

      await expect(listMessages(await getDb(), outsiderSession!, room.id)).rejects.toBeInstanceOf(ChatAccessError);
    } finally {
      await admin.cleanup();
      await outsider.cleanup();
    }
  });

  it('does not expose the planning corpus from another club', async () => {
    const outsider = await createTestUserAndSession('dirigeant', { clubId: 'other' }, ['arbitre_club']);
    const db = await getDb();
    try {
      const outsiderSession = await getSessionUser(outsider.token);
      await expect(
        runWithClubId(outsiderSession!.clubId, () =>
          getOrCreateEventRoom(db, outsiderSession!, 'officiel', 'foreign-event'),
        ),
      ).rejects.toBeInstanceOf(ChatValidationError);
    } finally {
      await outsider.cleanup();
    }
  });

  it('revokes event-chat access when the event is no longer published', async () => {
    const clubId = process.env.APP_CLUB_ID || 'afp';
    const member = await createTestUserAndSession('dirigeant', { clubId }, ['arbitre_club']);
    const eventId = `chat-event-${Date.now()}`;
    const db = await getDb();
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
          publishedByUserId: member.user.id,
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
              date: '20/08/2026',
              time: '18:00',
              localTeam: 'AFP',
              awayTeam: 'Visiteur',
              type: 'officiel',
            },
            extras: { id: eventId, planningStatus: 'published' },
            assignments: {
              arbitre: [{
                nom: member.user.nom,
                numero: '',
                personId: member.user.id,
                personType: 'officiel',
                status: 'accepted',
              }],
              encadrant: [],
              accompagnateur: [],
            },
          }],
        },
      }));
      const session = await getSessionUser(member.token);
      const room = await runWithClubId(clubId, () => getOrCreateEventRoom(db, session!, 'officiel', eventId));
      roomIds.push(room.id);

      // Une republication qui retire l'événement révoque le salon ; le statut live n'est
      // plus consulté comme source de visibilité.
      await runWithClubId(clubId, () => savePlanningRecord(db, {
        id: `published-planning:${clubId}`,
        clubId,
        kind: 'published-planning',
        payload: {
          schemaVersion: 1,
          publishedAt: new Date().toISOString(),
          publishedByUserId: member.user.id,
          events: [],
        },
      }));

      await expect(
        runWithClubId(clubId, () => listMessages(db, session!, room.id)),
      ).rejects.toBeInstanceOf(ChatAccessError);
    } finally {
      await db.query('DELETE FROM planning_records WHERE id = ? AND club_id = ?', [`published-planning:${clubId}`, clubId]);
      await db.getRepository('MatchExtra').delete({ matchId: eventId, clubId });
      await db.getRepository('MatchOfficial').delete({ id: eventId, clubId });
      await member.cleanup();
    }
  });

  it('makes an archived channel and its history inaccessible', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    try {
      const session = await getSessionUser(admin.token);
      const room = await createChannel(await getDb(), session!, { name: 'Archives' }, []);
      roomIds.push(room.id);
      await archiveChannel(await getDb(), session!, room.id);

      await expect(listMessages(await getDb(), session!, room.id)).rejects.toBeInstanceOf(ChatAccessError);
    } finally {
      await admin.cleanup();
    }
  });

  it('replies to a message with an author + snippet preview, and rejects citing a message from another room (issue #268)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const room = await createChannel(db, adminSession!, { name: 'Réponses' }, [member.user.id]);
      const otherRoom = await createChannel(db, adminSession!, { name: 'Autre salon' }, [member.user.id]);
      roomIds.push(room.id, otherRoom.id);

      const original = await appendMessage(db, adminSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440200',
        content: 'On se retrouve à 18h ?',
        attachment: null,
        replyToMessageId: null,
        forwardSourceMessageId: null,
      });

      const reply = await appendMessage(db, memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440201',
        content: 'Oui, parfait',
        attachment: null,
        replyToMessageId: original.message.id,
        forwardSourceMessageId: null,
      });
      expect(reply.message.replyTo).toEqual({
        id: original.message.id,
        authorName: admin.user.nom,
        snippet: 'On se retrouve à 18h ?',
        deleted: false,
      });

      const history = await listMessages(db, memberSession!, room.id);
      const replyInHistory = history.messages.find((m) => m.id === reply.message.id);
      expect(replyInHistory?.replyTo?.snippet).toBe('On se retrouve à 18h ?');

      await expect(
        appendMessage(db, memberSession!, {
          roomId: room.id,
          clientMessageId: '550e8400-e29b-41d4-a716-446655440202',
          content: 'Référence invalide',
          attachment: null,
          replyToMessageId: '550e8400-e29b-41d4-a716-446655449999',
          forwardSourceMessageId: null,
        }),
      ).rejects.toBeInstanceOf(ChatValidationError);

      const otherRoomMessage = await appendMessage(db, adminSession!, {
        roomId: otherRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440203',
        content: 'Message dans un autre salon',
        attachment: null,
        replyToMessageId: null,
        forwardSourceMessageId: null,
      });
      await expect(
        appendMessage(db, memberSession!, {
          roomId: room.id,
          clientMessageId: '550e8400-e29b-41d4-a716-446655440204',
          content: 'Citation hors salon',
          attachment: null,
          replyToMessageId: otherRoomMessage.message.id,
          forwardSourceMessageId: null,
        }),
      ).rejects.toBeInstanceOf(ChatValidationError);
    } finally {
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('forwarding an attachment duplicates it into the target room so its participants can open it, even without access to the source room (issue #268)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const target = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    const attachmentIds: string[] = [];
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const targetSession = await getSessionUser(target.token);
      const sourceRoom = await createChannel(db, adminSession!, { name: 'Salon source' }, []);
      const targetRoom = await createChannel(db, adminSession!, { name: 'Salon cible' }, [target.user.id]);
      roomIds.push(sourceRoom.id, targetRoom.id);

      const original = await saveChatAttachment(db, {
        clubId: adminSession!.clubId,
        roomId: sourceRoom.id,
        kind: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        content: Buffer.from('fake-png-bytes'),
        uploadedByUserId: admin.user.id,
      });
      attachmentIds.push(original.id);
      const originalMessage = await appendMessage(db, adminSession!, {
        roomId: sourceRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440209',
        content: 'Photo du terrain',
        attachment: {
          type: 'image',
          url: `/api/chat/attachments/${original.id}`,
          mimeType: 'image/png',
          name: 'photo.png',
          size: 14,
        },
        replyToMessageId: null,
        forwardSourceMessageId: null,
      });

      // `target` n'a jamais eu accès au salon source : la preuve que le transfert
      // fonctionne, c'est justement qu'il peut malgré tout ouvrir la pièce jointe.
      await expect(assertRoomAccess(db, targetSession!, sourceRoom.id)).rejects.toBeInstanceOf(ChatAccessError);

      const forwarded = await appendMessage(db, adminSession!, {
        roomId: targetRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440210',
        content: 'Regarde ça',
        attachment: {
          type: 'image',
          url: `/api/chat/attachments/${original.id}`,
          mimeType: 'image/png',
          name: 'photo.png',
          size: 14,
        },
        replyToMessageId: null,
        // Dérivé côté serveur depuis originalMessage, jamais fourni tel quel par le client.
        forwardSourceMessageId: originalMessage.message.id,
      });
      expect(forwarded.message.forwardedFromName).toBe(adminSession!.nom);
      expect(forwarded.message.content).toBe('Photo du terrain');
      expect(forwarded.message.attachment?.url).not.toBe(`/api/chat/attachments/${original.id}`);

      const copiedId = forwarded.message.attachment!.url.split('/').pop()!;
      attachmentIds.push(copiedId);
      const copied = await getChatAttachment(db, copiedId);
      expect(copied?.roomId).toBe(targetRoom.id);
      expect(copied?.content.toString()).toBe('fake-png-bytes');

      const targetHistory = await listMessages(db, targetSession!, targetRoom.id);
      expect(targetHistory.messages.at(-1)?.attachment?.url).toBe(`/api/chat/attachments/${copiedId}`);
    } finally {
      if (attachmentIds.length > 0) {
        await (await getDb()).query(`DELETE FROM chat_attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})`, attachmentIds);
      }
      await admin.cleanup();
      await target.cleanup();
    }
  });

  it('binds a forward to its source and never leaves a copied attachment after a rejected send (issue #268, revue Codex)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    let originalAttachmentId: string | null = null;
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const sourceRoom = await createChannel(db, adminSession!, { name: 'Source atomique' }, []);
      const targetRoom = await createChannel(db, adminSession!, { name: 'Cible atomique' }, []);
      roomIds.push(sourceRoom.id, targetRoom.id);

      const original = await saveChatAttachment(db, {
        clubId: adminSession!.clubId,
        roomId: sourceRoom.id,
        kind: 'image',
        fileName: 'source.png',
        mimeType: 'image/png',
        content: Buffer.from('source-bytes'),
        uploadedByUserId: admin.user.id,
      });
      originalAttachmentId = original.id;
      const source = await appendMessage(db, adminSession!, {
        roomId: sourceRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440241',
        content: 'Contenu authentique',
        attachment: {
          type: 'image',
          url: `/api/chat/attachments/${original.id}`,
          mimeType: 'image/png',
          name: 'source.png',
          size: 12,
        },
        replyToMessageId: null,
        forwardSourceMessageId: null,
      });

      await expect(appendMessage(db, adminSession!, {
        roomId: targetRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440242',
        content: 'Contenu falsifié',
        attachment: null,
        replyToMessageId: '550e8400-e29b-41d4-a716-446655449999',
        forwardSourceMessageId: source.message.id,
      })).rejects.toBeInstanceOf(ChatValidationError);
      expect(await db.query('SELECT id FROM chat_attachments WHERE room_id = ?', [targetRoom.id])).toHaveLength(0);

      await deleteMessage(db, adminSession!, sourceRoom.id, source.message.id);
      originalAttachmentId = null;
      await expect(appendMessage(db, adminSession!, {
        roomId: targetRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440243',
        content: 'Contenu falsifié',
        attachment: null,
        replyToMessageId: null,
        forwardSourceMessageId: source.message.id,
      })).rejects.toThrow('Un message supprimé ne peut pas être transféré');
      expect(await db.query('SELECT id FROM chat_attachments WHERE room_id = ?', [targetRoom.id])).toHaveLength(0);
    } finally {
      if (originalAttachmentId) {
        await (await getDb()).query('DELETE FROM chat_attachments WHERE id = ?', [originalAttachmentId]);
      }
      await admin.cleanup();
    }
  });

  it('rejects forwarding an attachment whose source room the sender cannot access (issue #268)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const owner = await createTestUserAndSession('admin', { clubId: 'afp' });
    const attachmentIds: string[] = [];
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const ownerSession = await getSessionUser(owner.token);
      const privateRoom = await createChannel(db, ownerSession!, { name: 'Salon privé' }, []);
      const adminRoom = await createChannel(db, adminSession!, { name: 'Salon admin' }, []);
      roomIds.push(privateRoom.id, adminRoom.id);

      const attachment = await saveChatAttachment(db, {
        clubId: ownerSession!.clubId,
        roomId: privateRoom.id,
        kind: 'image',
        fileName: 'secret.png',
        mimeType: 'image/png',
        content: Buffer.from('secret-bytes'),
        uploadedByUserId: owner.user.id,
      });
      attachmentIds.push(attachment.id);

      await expect(
        appendMessage(db, adminSession!, {
          roomId: adminRoom.id,
          clientMessageId: '550e8400-e29b-41d4-a716-446655440220',
          content: 'Tentative',
          attachment: {
            type: 'image',
            url: `/api/chat/attachments/${attachment.id}`,
            mimeType: 'image/png',
            name: 'secret.png',
            size: 12,
          },
          replyToMessageId: null,
          forwardSourceMessageId: null,
        }),
      ).rejects.toBeInstanceOf(ChatAccessError);
    } finally {
      if (attachmentIds.length > 0) {
        await (await getDb()).query(`DELETE FROM chat_attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})`, attachmentIds);
      }
      await admin.cleanup();
      await owner.cleanup();
    }
  });

  it('never trusts a client-supplied forwarded-from name: it rejects forwarding attribution to a message the sender cannot access (issue #268, revue Codex)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const owner = await createTestUserAndSession('admin', { clubId: 'afp' });
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const ownerSession = await getSessionUser(owner.token);
      const privateRoom = await createChannel(db, ownerSession!, { name: 'Salon privé (texte)' }, []);
      const adminRoom = await createChannel(db, adminSession!, { name: 'Salon admin (texte)' }, []);
      roomIds.push(privateRoom.id, adminRoom.id);

      const privateMessage = await appendMessage(db, ownerSession!, {
        roomId: privateRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440230',
        content: 'Message privé',
        attachment: null,
        replyToMessageId: null,
        forwardSourceMessageId: null,
      });

      await expect(
        appendMessage(db, adminSession!, {
          roomId: adminRoom.id,
          clientMessageId: '550e8400-e29b-41d4-a716-446655440231',
          content: 'Usurpation tentée',
          attachment: null,
          replyToMessageId: null,
          forwardSourceMessageId: privateMessage.message.id,
        }),
      ).rejects.toBeInstanceOf(ChatAccessError);

      await expect(
        appendMessage(db, adminSession!, {
          roomId: adminRoom.id,
          clientMessageId: '550e8400-e29b-41d4-a716-446655440232',
          content: 'Référence inexistante',
          attachment: null,
          replyToMessageId: null,
          forwardSourceMessageId: '550e8400-e29b-41d4-a716-446655449998',
        }),
      ).rejects.toBeInstanceOf(ChatValidationError);
    } finally {
      await admin.cleanup();
      await owner.cleanup();
    }
  });

  it('retrying an idempotent forward with an attachment does not leave an orphan attachment copy (issue #268, revue Codex)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const attachmentIds: string[] = [];
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const sourceRoom = await createChannel(db, adminSession!, { name: 'Source retry' }, []);
      const targetRoom = await createChannel(db, adminSession!, { name: 'Cible retry' }, []);
      roomIds.push(sourceRoom.id, targetRoom.id);

      const original = await saveChatAttachment(db, {
        clubId: adminSession!.clubId,
        roomId: sourceRoom.id,
        kind: 'image',
        fileName: 'plan.png',
        mimeType: 'image/png',
        content: Buffer.from('plan-bytes'),
        uploadedByUserId: admin.user.id,
      });
      attachmentIds.push(original.id);
      const sourceMessage = await appendMessage(db, adminSession!, {
        roomId: sourceRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440239',
        content: 'Retry transfert',
        attachment: {
          type: 'image',
          url: `/api/chat/attachments/${original.id}`,
          mimeType: 'image/png',
          name: 'plan.png',
          size: 10,
        },
        replyToMessageId: null,
        forwardSourceMessageId: null,
      });

      const command = {
        roomId: targetRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440240',
        content: 'Retry transfert',
        attachment: {
          type: 'image' as const,
          url: `/api/chat/attachments/${original.id}`,
          mimeType: 'image/png',
          name: 'plan.png',
          size: 10,
        },
        replyToMessageId: null,
        forwardSourceMessageId: sourceMessage.message.id,
      };

      const first = await appendMessage(db, adminSession!, command);
      expect(first.duplicate).toBe(false);
      const copiedId = first.message.attachment!.url.split('/').pop()!;
      attachmentIds.push(copiedId);

      // Même clientMessageId : simule un retry client après un accusé perdu en route.
      const retry = await appendMessage(db, adminSession!, command);
      expect(retry.duplicate).toBe(true);
      expect(retry.message.id).toBe(first.message.id);

      const rows = await db.query('SELECT id FROM chat_attachments WHERE room_id = ?', [targetRoom.id]) as Array<{ id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(copiedId);
    } finally {
      if (attachmentIds.length > 0) {
        await (await getDb()).query(`DELETE FROM chat_attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})`, attachmentIds);
      }
      await admin.cleanup();
    }
  });

  it('lets an admin delete a message: content/attachment purged, readers see the placeholder (issue #259)', async () => {
    const db = await getDb();
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    let attachmentId: string | null = null;
    try {
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const room = await createChannel(db, adminSession!, { name: 'Modération' }, [member.user.id]);
      roomIds.push(room.id);

      const attachment = await saveChatAttachment(db, {
        clubId: memberSession!.clubId,
        roomId: room.id,
        kind: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        content: Buffer.from('photo-bytes'),
        uploadedByUserId: member.user.id,
      });
      attachmentId = attachment.id;

      const posted = await appendMessage(db, memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449900',
        content: 'Message à modérer',
        attachment: {
          type: 'image',
          url: `/api/chat/attachments/${attachment.id}`,
          mimeType: 'image/png',
          name: 'photo.png',
          size: 11,
        },
      });

      const result = await deleteMessage(db, adminSession!, room.id, posted.message.id);
      expect(result.message.content).toBe('');
      expect(result.message.attachment).toBeNull();
      expect(result.message.deletedAt).not.toBeNull();
      expect(await getChatAttachment(db, attachment.id)).toBeNull();

      const history = await listMessages(db, memberSession!, room.id);
      const stillThere = history.messages.find((m) => m.id === posted.message.id);
      expect(stillThere).toBeDefined();
      expect(stillThere!.content).toBe('');
      expect(stillThere!.attachment).toBeNull();
      expect(stillThere!.deletedAt).not.toBeNull();
    } finally {
      if (attachmentId) {
        await db.query('DELETE FROM chat_attachments WHERE id = ?', [attachmentId]);
      }
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('deletes the stored attachment blob, not just the reference, so its URL stops serving it (issue #259, revue Codex)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const room = await createChannel(db, adminSession!, { name: 'Modération pièce jointe' }, [member.user.id]);
      roomIds.push(room.id);

      const attachment = await saveChatAttachment(db, {
        clubId: adminSession!.clubId,
        roomId: room.id,
        kind: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        content: Buffer.from('photo-bytes'),
        uploadedByUserId: member.user.id,
      });
      const posted = await appendMessage(db, memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449910',
        content: '',
        attachment: {
          type: 'image',
          url: `/api/chat/attachments/${attachment.id}`,
          mimeType: 'image/png',
          name: 'photo.png',
          size: 11,
        },
      });
      expect(await getChatAttachment(db, attachment.id)).not.toBeNull();

      await deleteMessage(db, adminSession!, room.id, posted.message.id);

      expect(await getChatAttachment(db, attachment.id)).toBeNull();
    } finally {
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('rejects message deletion by a non-admin who is not the author (issue #10)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    const otherMember = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const otherMemberSession = await getSessionUser(otherMember.token);
      const room = await createChannel(await getDb(), adminSession!, { name: 'Modération 2' }, [member.user.id, otherMember.user.id]);
      roomIds.push(room.id);
      const posted = await appendMessage(await getDb(), memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449902',
        content: 'Message',
        attachment: null,
      });

      await expect(deleteMessage(await getDb(), otherMemberSession!, room.id, posted.message.id))
        .rejects.toBeInstanceOf(ChatAccessError);

      const history = await listMessages(await getDb(), memberSession!, room.id);
      const stillThere = history.messages.find((m) => m.id === posted.message.id);
      expect(stillThere?.deletedAt).toBeNull();
    } finally {
      await admin.cleanup();
      await member.cleanup();
      await otherMember.cleanup();
    }
  });

  it('lets a non-admin author delete their own message (issue #10)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    let attachmentId: string | null = null;
    try {
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const room = await createChannel(await getDb(), adminSession!, { name: 'Auteur' }, [member.user.id]);
      roomIds.push(room.id);

      const attachment = await saveChatAttachment(await getDb(), {
        clubId: memberSession!.clubId,
        roomId: room.id,
        kind: 'image',
        fileName: 'photo.png',
        mimeType: 'image/png',
        content: Buffer.from('photo-bytes'),
        uploadedByUserId: member.user.id,
      });
      attachmentId = attachment.id;

      const posted = await appendMessage(await getDb(), memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449904',
        content: 'Mon message',
        attachment: {
          type: 'image',
          url: `/api/chat/attachments/${attachment.id}`,
          mimeType: 'image/png',
          name: 'photo.png',
          size: 11,
        },
      });

      // L'auteur (non-admin) supprime son propre message : pas de requireAdmin.
      const result = await deleteMessage(await getDb(), memberSession!, room.id, posted.message.id);
      expect(result.message.content).toBe('');
      expect(result.message.attachment).toBeNull();
      expect(result.message.deletedAt).not.toBeNull();
      expect(await getChatAttachment(await getDb(), attachment.id)).toBeNull();

      const history = await listMessages(await getDb(), adminSession!, room.id);
      const stillThere = history.messages.find((m) => m.id === posted.message.id);
      expect(stillThere).toBeDefined();
      expect(stillThere!.content).toBe('');
      expect(stillThere!.deletedAt).not.toBeNull();
    } finally {
      if (attachmentId) {
        await (await getDb()).query('DELETE FROM chat_attachments WHERE id = ?', [attachmentId]);
      }
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('rejects self-deletion by an author who no longer has access to the room (issue #10)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const room = await createChannel(await getDb(), adminSession!, { name: 'Auteur retiré' }, [member.user.id]);
      roomIds.push(room.id);
      const posted = await appendMessage(await getDb(), memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449905',
        content: 'Avant retrait',
        attachment: null,
      });

      // Un admin retire le membre du canal : il ne participe plus au salon.
      await (await getDb()).getRepository('ChatParticipant').delete({ roomId: room.id, userId: member.user.id });

      await expect(deleteMessage(await getDb(), memberSession!, room.id, posted.message.id))
        .rejects.toBeInstanceOf(ChatAccessError);
    } finally {
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('still lets an admin delete another member\'s message (issue #259 unchanged)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const room = await createChannel(await getDb(), adminSession!, { name: 'Modération admin' }, [member.user.id]);
      roomIds.push(room.id);
      const posted = await appendMessage(await getDb(), memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449906',
        content: 'Message modérable',
        attachment: null,
      });

      const result = await deleteMessage(await getDb(), adminSession!, room.id, posted.message.id);
      expect(result.message.deletedAt).not.toBeNull();
    } finally {
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('never reexposes a deleted message\'s content or author through a reply preview (issue #10)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const room = await createChannel(await getDb(), adminSession!, { name: 'Réponse' }, [member.user.id]);
      roomIds.push(room.id);

      const original = await appendMessage(await getDb(), memberSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449907',
        content: 'Contenu sensible',
        attachment: null,
      });
      const reply = await appendMessage(await getDb(), adminSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449908',
        content: 'En réponse',
        attachment: null,
        replyToMessageId: original.message.id,
      });
      expect(reply.message.replyTo?.deleted).toBe(false);
      expect(reply.message.replyTo?.snippet).toBe('Contenu sensible');

      // L'auteur supprime le message original après coup.
      await deleteMessage(await getDb(), memberSession!, room.id, original.message.id);

      const history = await listMessages(await getDb(), adminSession!, room.id);
      const replyAfterDeletion = history.messages.find((m) => m.id === reply.message.id);
      expect(replyAfterDeletion?.replyTo?.deleted).toBe(true);
      expect(replyAfterDeletion?.replyTo?.authorName).toBe('');
      expect(replyAfterDeletion?.replyTo?.snippet).toBe('');
    } finally {
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('rejects message deletion by an admin who is not a participant of a direct room', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const outsiderAdmin = await createTestUserAndSession('admin', { clubId: 'afp' });
    try {
      const adminSession = await getSessionUser(admin.token);
      const outsiderAdminSession = await getSessionUser(outsiderAdmin.token);
      const room = await createChannel(await getDb(), adminSession!, { name: 'Privé admin' }, []);
      roomIds.push(room.id);
      const posted = await appendMessage(await getDb(), adminSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449903',
        content: 'Message privé',
        attachment: null,
      });

      await expect(deleteMessage(await getDb(), outsiderAdminSession!, room.id, posted.message.id))
        .rejects.toBeInstanceOf(ChatAccessError);
    } finally {
      await admin.cleanup();
      await outsiderAdmin.cleanup();
    }
  });

  it('anonymizes direct and forwarded attribution for a deleted account (issues #259/#268)', async () => {
    const admin = await createTestUserAndSession('admin', { clubId: 'afp' });
    const member = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const db = await getDb();
      const adminSession = await getSessionUser(admin.token);
      const memberSession = await getSessionUser(member.token);
      const sourceRoom = await createChannel(db, adminSession!, { name: 'Anonymisation source' }, [member.user.id]);
      const targetRoom = await createChannel(db, adminSession!, { name: 'Anonymisation cible' }, []);
      roomIds.push(sourceRoom.id, targetRoom.id);
      const source = await appendMessage(db, memberSession!, {
        roomId: sourceRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449904',
        content: 'Un message',
        attachment: null,
      });
      await appendMessage(db, adminSession!, {
        roomId: targetRoom.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655449905',
        content: 'Texte client ignoré',
        attachment: null,
        forwardSourceMessageId: source.message.id,
      });

      await anonymizeMessagesForDeletedUser(db, member.user.id);

      const sourceHistory = await listMessages(db, adminSession!, sourceRoom.id);
      const targetHistory = await listMessages(db, adminSession!, targetRoom.id);
      expect(sourceHistory.messages[0]!.senderName).toBe(ANONYMIZED_SENDER_NAME);
      expect(targetHistory.messages[0]!.content).toBe('Un message');
      expect(targetHistory.messages[0]!.forwardedFromName).toBe(ANONYMIZED_SENDER_NAME);
    } finally {
      await admin.cleanup();
      await member.cleanup();
    }
  });

  it('toggles an emoji reaction on a message and lists it in history', async () => {
    const first = await createTestUserAndSession('admin', { clubId: 'afp' });
    const second = await createTestUserAndSession('dirigeant', { clubId: 'afp' }, ['arbitre_club']);
    try {
      const firstSession = await getSessionUser(first.token);
      const secondSession = await getSessionUser(second.token);
      const room = await createChannel(await getDb(), firstSession!, { name: 'Réactions' }, [second.user.id]);
      roomIds.push(room.id);
      const sent = await appendMessage(await getDb(), firstSession!, {
        roomId: room.id,
        clientMessageId: '550e8400-e29b-41d4-a716-446655440077',
        content: 'Bravo',
        attachment: null,
        replyToMessageId: null,
        forwardSourceMessageId: null,
      });

      const added = await toggleMessageReaction(await getDb(), secondSession!, room.id, sent.message.id, '👍');
      expect(added.added).toBe(true);
      expect(added.message.content).toBe('Bravo');
      expect(added.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [second.user.id] }]);

      const history = await listMessages(await getDb(), firstSession!, room.id);
      expect(history.messages[0]!.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [second.user.id] }]);

      const removed = await toggleMessageReaction(await getDb(), secondSession!, room.id, sent.message.id, '👍');
      expect(removed.added).toBe(false);
      expect(removed.reactions).toEqual([]);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});
