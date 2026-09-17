import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { runRetentionPurge } from '@/lib/retention/purge';
import { POST } from '@/app/api/cron/retention-purge/route';

const dbAvailable = await isDbAvailable();

function cronRequest(headers?: HeadersInit, url = 'http://localhost/api/cron/retention-purge') {
  return new NextRequest(url, { method: 'POST', headers });
}

describe('POST /api/cron/retention-purge auth (issue #9)', () => {
  const previousSecret = process.env.CRON_SECRET;

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  });

  it('rejects a missing or invalid secret', async () => {
    delete process.env.CRON_SECRET;
    expect((await POST(cronRequest())).status).toBe(401);

    process.env.CRON_SECRET = 'expected-secret';
    expect((await POST(cronRequest({ authorization: 'Bearer other-secret' }))).status).toBe(401);
    expect((await POST(cronRequest())).status).toBe(401);
  });
});

describe.skipIf(!dbAvailable)('runRetentionPurge (issue #9)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('dry-run then deletes old blobs with metadata, isolates clubs, and is idempotent', async () => {
    const db = await getDb();
    const clubA = `ret-a-${randomBytes(4).toString('hex')}`;
    const clubB = `ret-b-${randomBytes(4).toString('hex')}`;
    const accountA = await createTestUserAndSession('admin', { clubId: clubA });
    const accountB = await createTestUserAndSession('admin', { clubId: clubB });
    const oldId = `att-old-${randomBytes(4).toString('hex')}`;
    const recentId = `att-new-${randomBytes(4).toString('hex')}`;
    const otherId = `att-b-${randomBytes(4).toString('hex')}`;
    const reportId = `post-event-report:${randomBytes(4).toString('hex')}`;

    cleanups.push(async () => {
      await db.query('DELETE FROM planning_attachments WHERE club_id IN (?, ?)', [clubA, clubB]);
      await db.query('DELETE FROM planning_records WHERE club_id IN (?, ?)', [clubA, clubB]);
      await db.query('DELETE FROM retention_purge_runs WHERE summary LIKE ?', [`%${clubA}%`]).catch(() => undefined);
      await accountA.cleanup();
      await accountB.cleanup();
      await db.getRepository('ClubTenant').delete({ id: clubA }).catch(() => undefined);
      await db.getRepository('ClubTenant').delete({ id: clubB }).catch(() => undefined);
    });

    const insertAttachment = async (id: string, clubId: string, userId: number) => {
      await db.query(
        `INSERT INTO planning_attachments
          (id, club_id, event_type, event_id, file_name, mime_type, size_bytes, content, uploaded_by_user_id)
         VALUES (?, ?, 'entrainement', 'evt-1', 'notes.txt', 'text/plain', 4, ?, ?)`,
        [id, clubId, Buffer.from('blob'), userId],
      );
    };
    await insertAttachment(oldId, clubA, accountA.user.id);
    await insertAttachment(recentId, clubA, accountA.user.id);
    await insertAttachment(otherId, clubB, accountB.user.id);
    await db.query('UPDATE planning_attachments SET created_at = ? WHERE id = ?', ['2019-01-02 00:00:00', oldId]);
    await db.query('UPDATE planning_attachments SET created_at = ? WHERE id = ?', ['2019-01-02 00:00:00', otherId]);
    await db.query(
      `INSERT INTO planning_records (id, club_id, kind, event_type, event_id, owner_user_id, payload)
       VALUES (?, ?, 'post-event-report', 'entrainement', 'evt-1', ?, ?)`,
      [reportId, clubA, accountA.user.id, JSON.stringify({ category: 'incident', text: 'x' })],
    );
    await db.query('UPDATE planning_records SET created_at = ? WHERE id = ?', ['2019-01-02 00:00:00', reportId]);

    const dry = await runRetentionPurge(db, { dryRun: true, clubIds: [clubA, clubB] });
    expect(dry.success).toBe(true);
    expect(dry.dryRun).toBe(true);
    const attachDry = dry.categories.find((item) => item.category === 'planningAttachments');
    expect(attachDry?.scanned).toBeGreaterThanOrEqual(2);
    expect(attachDry?.deleted).toBe(0);
    expect(JSON.stringify(dry)).not.toMatch(/notes\.txt|@example\.com|blob/i);

    const remainingAfterDry = await db.query(
      'SELECT id FROM planning_attachments WHERE id IN (?, ?, ?)',
      [oldId, recentId, otherId],
    );
    expect(remainingAfterDry).toHaveLength(3);

    const applied = await runRetentionPurge(db, { dryRun: false, clubIds: [clubA] });
    expect(applied.success).toBe(true);
    const ids = (await db.query(
      'SELECT id FROM planning_attachments WHERE id IN (?, ?, ?)',
      [oldId, recentId, otherId],
    ) as Array<{ id: string }>).map((row) => row.id).sort();
    expect(ids).toEqual([otherId, recentId].sort());
    const reports = await db.query('SELECT id FROM planning_records WHERE id = ?', [reportId]);
    expect(reports).toHaveLength(0);

    const second = await runRetentionPurge(db, { dryRun: false, clubIds: [clubA] });
    const attachSecond = second.categories.find((item) => item.category === 'planningAttachments');
    expect(attachSecond?.deleted).toBe(0);
  });

  it('purge les liens de partage public expirés peu après leur échéance, sans attendre la fenêtre de 90 jours (issue #14)', async () => {
    const db = await getDb();
    const clubId = `ret-share-${randomBytes(4).toString('hex')}`;
    const account = await createTestUserAndSession('admin', { clubId });

    // Créé récemment (bien en-deçà du filet de sécurité `publicShares`/90 j sur
    // `created_at`), mais expiré depuis plus de 7 j : ne doit survivre qu'à la
    // purge générale, jamais à la purge technique courte sur `expiresAt`.
    const expiredId = `public-share:${randomBytes(4).toString('hex')}`;
    // Non expiré : ne doit être purgé par aucune des deux catégories.
    const activeId = `public-share:${randomBytes(4).toString('hex')}`;

    cleanups.push(async () => {
      await db.query('DELETE FROM planning_records WHERE club_id = ?', [clubId]);
      await db.query('DELETE FROM retention_purge_runs WHERE summary LIKE ?', [`%${clubId}%`]).catch(() => undefined);
      await account.cleanup();
      await db.getRepository('ClubTenant').delete({ id: clubId }).catch(() => undefined);
    });

    const expiredAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const activeExpiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const scope = { eventTypes: [], fromDate: null, toDate: null };

    await db.query(
      `INSERT INTO planning_records (id, club_id, kind, owner_user_id, payload)
       VALUES (?, ?, 'public-share', ?, ?)`,
      [expiredId, clubId, account.user.id, JSON.stringify({ tokenHash: 'x', expiresAt: expiredAt, scope, createdByUserId: account.user.id })],
    );
    await db.query(
      `INSERT INTO planning_records (id, club_id, kind, owner_user_id, payload)
       VALUES (?, ?, 'public-share', ?, ?)`,
      [activeId, clubId, account.user.id, JSON.stringify({ tokenHash: 'y', expiresAt: activeExpiresAt, scope, createdByUserId: account.user.id })],
    );
    // Créés « aujourd'hui » : sans cette purge dédiée, le lien expiré serait
    // encore là au bout de 89 jours (filet de sécurité `publicShares` = 90 j).

    const dry = await runRetentionPurge(db, { dryRun: true, clubIds: [clubId] });
    const expiredCategoryDry = dry.categories.find((item) => item.category === 'publicSharesExpired');
    expect(expiredCategoryDry?.scanned).toBeGreaterThanOrEqual(1);
    expect(expiredCategoryDry?.deleted).toBe(0);
    const remainingAfterDry = await db.query('SELECT id FROM planning_records WHERE id IN (?, ?)', [expiredId, activeId]);
    expect(remainingAfterDry).toHaveLength(2);

    const applied = await runRetentionPurge(db, { dryRun: false, clubIds: [clubId] });
    expect(applied.success).toBe(true);
    const remainingIds = (await db.query(
      'SELECT id FROM planning_records WHERE id IN (?, ?)',
      [expiredId, activeId],
    ) as Array<{ id: string }>).map((row) => row.id);
    expect(remainingIds).toEqual([activeId]);

    const second = await runRetentionPurge(db, { dryRun: false, clubIds: [clubId] });
    const expiredCategorySecond = second.categories.find((item) => item.category === 'publicSharesExpired');
    expect(expiredCategorySecond?.deleted).toBe(0);
  });
});
