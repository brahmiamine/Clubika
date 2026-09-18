/**
 * Suite « privacy invariants » (issue #41) — scénarios de cycle de vie.
 *
 * Contrairement à `boundaries.test.ts` (fonctions pures, pas de DB), ces cas ont
 * besoin d'une vraie base pour vérifier qu'une donnée sentinelle est réellement
 * absente *après coup*, pas seulement absente du DTO de sortie. Chaque cas
 * appelle la vraie fonction déjà livrée par son ticket (#9 rétention, #259
 * modération de message, #273 anonymisation de compte, #25 offboarding tenant) —
 * aucune n'est réimplémentée ici. Suit la convention `*.integration.test.ts` /
 * `describe.skipIf(!isDbAvailable())` déjà utilisée dans ce dépôt.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { getSessionUser } from '@/lib/auth/session';
import { runWithClubId } from '@/lib/auth/club-context';
import { createChannel, deleteMessage } from '@/lib/chat/service';
import { closeAccount } from '@/lib/account-closure/close-account';
import { runRetentionPurge } from '@/lib/retention/purge';
import { freezeClub, cancelFreeze } from '@/lib/tenant-offboarding/freeze';
import { purgeClub, residualSearchHits } from '@/lib/tenant-offboarding/purge';
import { hashPassword } from '@/lib/auth/password';
import { createPlatformSession, PLATFORM_SESSION_COOKIE_NAME } from '@/lib/auth/platform-session';
import { forbiddenSentinelBundle, sentinelClubId } from './sentinel-factory';

const dbAvailable = await isDbAvailable();

async function platformAuth() {
  const db = await getDb();
  const admin = await db.getRepository('PlatformAdmin').save({
    email: `lifecycle-admin-${randomBytes(6).toString('hex')}@example.com`,
    passwordHash: await hashPassword('test-password-123'),
    nom: 'Lifecycle Platform Admin',
    active: true,
  });
  const { token } = await createPlatformSession(admin.id);
  return {
    admin,
    token,
    headers: { cookie: `${PLATFORM_SESSION_COOKIE_NAME}=${token}` },
    cleanup: async () => {
      await db.getRepository('PlatformSession').delete({ id: token });
      await db.getRepository('PlatformAdmin').delete({ id: admin.id });
    },
  };
}

async function createClubTenant(id: string, name: string) {
  const db = await getDb();
  await db.getRepository('ClubTenant').save({
    id,
    name,
    abbreviation: 'LC',
    description: '',
    logo: '',
    themeMode: 'system',
    primaryColor: '#1f2937',
    secondaryColor: '#e5e7eb',
    timeZone: 'Europe/Paris',
    matchesUrlKey: '',
    scraperClubName: '',
    featuresJson: '{}',
    active: true,
    offboardingStatus: 'none',
    legalHoldActive: false,
  });
}

describe.skipIf(!dbAvailable)('scénarios de cycle de vie (issue #41)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  it('rétention : purge un message et sa pièce jointe expirés, sans toucher le club voisin', async () => {
    const db = await getDb();
    const clubId = sentinelClubId('retention');
    const bundle = forbiddenSentinelBundle('retention');
    const admin = await createTestUserAndSession('admin', { clubId });
    cleanups.push(admin.cleanup);

    const roomId = `room-${randomBytes(8).toString('hex')}`;
    const attachmentId = `att-${randomBytes(8).toString('hex')}`;
    const messageId = `msg-${randomBytes(8).toString('hex')}`;
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000); // au-delà des 365 jours par défaut (issue #9)

    await db.query(
      `INSERT INTO chat_rooms (id, type, clubId, roomKey, name, createdByUserId, createdAt)
       VALUES (?, 'direct', ?, ?, NULL, ?, ?)`,
      [roomId, clubId, `key-${roomId}`, admin.user.id, old],
    );
    await db.query(
      `INSERT INTO chat_attachments (id, club_id, room_id, kind, file_name, mime_type, size_bytes, content, uploaded_by_user_id, created_at)
       VALUES (?, ?, ?, 'document', 'sentinel.txt', 'text/plain', ?, ?, ?, ?)`,
      [attachmentId, clubId, roomId, Buffer.byteLength(bundle.rawText), Buffer.from(bundle.rawText), admin.user.id, old],
    );
    await db.query(
      `INSERT INTO chat_messages
        (id, roomId, senderUserId, senderName, clientMessageId, sequence, content, attachmentType, attachmentUrl, attachmentMimeType, attachmentName, attachmentSize, createdAt)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'document', ?, 'text/plain', 'sentinel.txt', ?, ?)`,
      [
        messageId, roomId, admin.user.id, bundle.name, randomBytes(8).toString('hex'),
        bundle.freeText, `/api/chat/attachments/${attachmentId}`, Buffer.byteLength(bundle.rawText), old,
      ],
    );
    cleanups.push(async () => {
      await db.query('DELETE FROM chat_messages WHERE id = ?', [messageId]);
      await db.query('DELETE FROM chat_attachments WHERE id = ?', [attachmentId]);
      await db.query('DELETE FROM chat_rooms WHERE id = ?', [roomId]);
    });

    const report = await runRetentionPurge(db, { dryRun: false, clubIds: [clubId] });
    expect(report.success).toBe(true);
    const chatCategory = report.categories.find((c) => c.category === 'chat');
    expect(chatCategory?.deleted).toBeGreaterThan(0);

    const survivingMessages = await db.query('SELECT id FROM chat_messages WHERE id = ?', [messageId]) as unknown[];
    const survivingAttachments = await db.query('SELECT id FROM chat_attachments WHERE id = ?', [attachmentId]) as unknown[];
    expect(survivingMessages).toEqual([]);
    expect(survivingAttachments).toEqual([]);
  });

  it('suppression : modérer un message purge son contenu et sa pièce jointe, garde la ligne', async () => {
    const db = await getDb();
    const clubId = sentinelClubId('moderation');
    const bundle = forbiddenSentinelBundle('moderation');
    const admin = await createTestUserAndSession('admin', { clubId });
    cleanups.push(admin.cleanup);
    const adminSession = await getSessionUser(admin.token);
    const room = await createChannel(db, adminSession!, { name: 'Moderation sentinelle' }, []);
    cleanups.push(async () => {
      await db.query('DELETE FROM chat_participants WHERE roomId = ?', [room.id]);
      await db.query('DELETE FROM chat_rooms WHERE id = ?', [room.id]);
    });

    const attachmentId = `att-${randomBytes(8).toString('hex')}`;
    const messageId = `msg-${randomBytes(8).toString('hex')}`;
    await db.query(
      `INSERT INTO chat_attachments (id, club_id, room_id, kind, file_name, mime_type, size_bytes, content, uploaded_by_user_id)
       VALUES (?, ?, ?, 'document', 'sentinel.txt', 'text/plain', ?, ?, ?)`,
      [attachmentId, clubId, room.id, Buffer.byteLength(bundle.rawText), Buffer.from(bundle.rawText), admin.user.id],
    );
    await db.query(
      `INSERT INTO chat_messages
        (id, roomId, senderUserId, senderName, clientMessageId, sequence, content, attachmentType, attachmentUrl, attachmentMimeType, attachmentName, attachmentSize)
       VALUES (?, ?, ?, ?, ?, 1, ?, 'document', ?, 'text/plain', 'sentinel.txt', ?)`,
      [
        messageId, room.id, admin.user.id, bundle.name, randomBytes(8).toString('hex'),
        bundle.freeText, `/api/chat/attachments/${attachmentId}`, Buffer.byteLength(bundle.rawText),
      ],
    );

    const outcome = await deleteMessage(db, adminSession!, room.id, messageId);
    expect(outcome.message.content).toBe('');
    expect(outcome.message.attachment).toBeNull();

    const attachmentRows = await db.query('SELECT id FROM chat_attachments WHERE id = ?', [attachmentId]) as unknown[];
    expect(attachmentRows).toEqual([]);
    const messageRows = await db.query(
      'SELECT content, attachmentUrl, senderName FROM chat_messages WHERE id = ?',
      [messageId],
    ) as Array<{ content: string; attachmentUrl: string | null; senderName: string }>;
    expect(messageRows[0]?.content).toBe('');
    expect(messageRows[0]?.attachmentUrl).toBeNull();
    // Le nom de l'expéditeur n'est pas une donnée du message modéré : il n'est pas
    // touché par cette action (seule l'anonymisation de compte le change).
    expect(JSON.stringify(messageRows)).not.toContain(bundle.freeText);
    expect(JSON.stringify(messageRows)).not.toContain(bundle.rawText);
  });

  it('anonymisation compte : purge nom/e-mail/téléphone et les messages de chat envoyés', async () => {
    const db = await getDb();
    const clubId = sentinelClubId('anonymize');
    const bundle = forbiddenSentinelBundle('anonymize');
    const admin = await createTestUserAndSession('admin', { clubId });
    const target = await createTestUserAndSession('dirigeant', {
      clubId,
      nom: bundle.name,
      email: bundle.email,
      telephone: bundle.phone,
    });
    cleanups.push(admin.cleanup, target.cleanup);
    const adminSession = await getSessionUser(admin.token);
    const targetSession = await getSessionUser(target.token);
    const room = await createChannel(db, adminSession!, { name: 'Anonymisation sentinelle' }, [target.user.id]);
    cleanups.push(async () => {
      await db.query('DELETE FROM chat_messages WHERE roomId = ?', [room.id]);
      await db.query('DELETE FROM chat_participants WHERE roomId = ?', [room.id]);
      await db.query('DELETE FROM chat_rooms WHERE id = ?', [room.id]);
    });

    await db.query(
      `INSERT INTO chat_messages (id, roomId, senderUserId, senderName, clientMessageId, sequence, content)
       VALUES (?, ?, ?, ?, ?, 2, ?)`,
      [`msg-${randomBytes(8).toString('hex')}`, room.id, target.user.id, targetSession!.nom, randomBytes(8).toString('hex'), 'message ordinaire'],
    );

    const result = await runWithClubId(clubId, () =>
      closeAccount(db, {
        target: target.user,
        processedByUserId: admin.user.id,
        processedByRole: 'admin',
        activeAdminCount: 2,
      }),
    );
    expect(result.alreadyClosed).toBe(false);

    const stored = await db.getRepository('User').findOneByOrFail({ id: target.user.id }) as {
      nom: string; email: string; telephone: string | null;
    };
    expect(stored.nom).not.toBe(bundle.name);
    expect(stored.email).not.toBe(bundle.email);
    expect(stored.telephone).toBeNull();
    expect(JSON.stringify(stored)).not.toContain(bundle.name);
    expect(JSON.stringify(stored)).not.toContain(bundle.email);
    expect(JSON.stringify(stored)).not.toContain(bundle.phone);

    const messages = await db.query(
      'SELECT senderName FROM chat_messages WHERE roomId = ? AND senderUserId = ?',
      [room.id, target.user.id],
    ) as Array<{ senderName: string }>;
    for (const message of messages) {
      expect(message.senderName).not.toBe(bundle.name);
      expect(message.senderName).not.toContain(bundle.name);
    }
  });

  it('offboarding tenant : la purge n\'oublie aucune donnée sentinelle et épargne le club voisin', async () => {
    const db = await getDb();
    const auth = await platformAuth();
    cleanups.push(auth.cleanup);
    const clubA = sentinelClubId('offboard-a');
    const clubB = sentinelClubId('offboard-b');
    const bundle = forbiddenSentinelBundle('offboard');
    await createClubTenant(clubA, `Club sentinelle A`);
    await createClubTenant(clubB, `Club sentinelle B`);
    cleanups.push(async () => {
      await db.query('DELETE FROM tenant_offboarding_events WHERE clubId IN (?, ?)', [clubA, clubB]);
      await db.query('DELETE FROM tenant_processor_instructions WHERE clubId IN (?, ?)', [clubA, clubB]);
      await db.query('DELETE FROM tenant_deletion_certificates WHERE clubId IN (?, ?)', [clubA, clubB]);
      await db.query('DELETE FROM club_tenants WHERE id IN (?, ?)', [clubA, clubB]);
    });

    const userA = await db.getRepository('User').save({
      clubId: clubA,
      email: bundle.email,
      passwordHash: await hashPassword('test-password-123'),
      nom: bundle.name,
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      icalToken: randomBytes(12).toString('hex'),
    });
    const userB = await db.getRepository('User').save({
      clubId: clubB,
      email: `neighbor-${randomBytes(4).toString('hex')}@example.test`,
      passwordHash: await hashPassword('test-password-123'),
      nom: 'Voisin Sentinelle',
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      icalToken: randomBytes(12).toString('hex'),
    });

    await freezeClub(db, clubA, { platformAdminId: auth.admin.id, retentionUntil: null });
    const purged = await purgeClub(db, clubA, {
      dryRun: false,
      overrideRetention: true,
      confirmClubId: clubA,
      platformAdminId: auth.admin.id,
    });
    expect(purged.success).toBe(true);
    expect(JSON.stringify(purged.certificate)).not.toContain(bundle.email);
    expect(JSON.stringify(purged.certificate)).not.toContain(bundle.name);

    const hits = await residualSearchHits(db, clubA, [bundle.email, bundle.name]);
    expect(hits).toEqual([]);
    expect(await db.getRepository('User').findOneBy({ id: userA.id })).toBeNull();

    const survivor = await db.getRepository('User').findOneBy({ id: userB.id });
    expect(survivor?.email).toBe(userB.email);
  });

  it('restauration après suppression : annuler le gel restitue le club avant toute purge', async () => {
    const db = await getDb();
    const auth = await platformAuth();
    cleanups.push(auth.cleanup);
    const clubId = sentinelClubId('restore');
    const bundle = forbiddenSentinelBundle('restore');
    await createClubTenant(clubId, `Club à restaurer`);
    cleanups.push(async () => {
      await db.query('DELETE FROM tenant_offboarding_events WHERE clubId = ?', [clubId]);
      await db.query('DELETE FROM tenant_processor_instructions WHERE clubId = ?', [clubId]);
      await db.query('DELETE FROM club_tenants WHERE id = ?', [clubId]);
    });
    const user = await db.getRepository('User').save({
      clubId,
      email: bundle.email,
      passwordHash: await hashPassword('test-password-123'),
      nom: bundle.name,
      accessRole: 'admin',
      planningFunctions: [],
      active: true,
      claimedAt: new Date(),
      icalToken: randomBytes(12).toString('hex'),
    });
    cleanups.push(async () => {
      await db.getRepository('User').delete({ id: user.id });
    });

    await freezeClub(db, clubId, { platformAdminId: auth.admin.id, retentionUntil: null });
    const frozen = await db.getRepository('ClubTenant').findOneBy({ id: clubId });
    expect(frozen?.offboardingStatus).toBe('frozen');
    expect(frozen?.active).toBe(false);

    const restored = await cancelFreeze(db, clubId, auth.admin.id);
    expect(restored.offboardingStatus).toBe('none');
    expect(restored.frozenAt).toBeNull();

    // Restauré, pas anonymisé ni purgé : la donnée sentinelle est toujours là.
    const stillThere = await db.getRepository('User').findOneBy({ id: user.id });
    expect(stillThere?.nom).toBe(bundle.name);
    expect(stillThere?.email).toBe(bundle.email);

    // Un gel déjà annulé ne peut pas être annulé une seconde fois (état non ambigu).
    await expect(cancelFreeze(db, clubId, auth.admin.id)).rejects.toThrow(/pas gelé/i);
  });
});
