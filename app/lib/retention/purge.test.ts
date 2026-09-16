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
});
