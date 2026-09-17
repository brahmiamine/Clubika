import { randomUUID } from 'node:crypto';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { enqueueNotificationDelivery } from './outbox';

const dbAvailable = await isDbAvailable();

/**
 * Vérifie contre une vraie base que la contrainte d'unicité posée par la migration 0016
 * (issue #276) fait effectivement converger deux tentatives portant la même empreinte
 * d'idempotence sur une seule ligne d'outbox — le comportement exact dont dépend
 * « retrying the same publication does not duplicate notifications ».
 */
describe.skipIf(!dbAvailable)('planning_notification_outbox — contrainte d\'idempotence (issue #276)', () => {
  let userId = 0;
  let cleanupUser: (() => Promise<void>) | null = null;
  const cleanupIds: string[] = [];

  beforeEach(async () => {
    const { user, cleanup } = await createTestUserAndSession('dirigeant');
    userId = user.id;
    cleanupUser = cleanup;
  });

  afterEach(async () => {
    const db = await getDb();
    for (const id of cleanupIds) {
      await db.query('DELETE FROM planning_notification_outbox WHERE id = ?', [id]);
    }
    cleanupIds.length = 0;
    if (cleanupUser) {
      await cleanupUser();
      cleanupUser = null;
    }
  });

  function input() {
    return {
      userId,
      channel: 'push' as const,
      templateId: 'planning' as const,
      notificationId: null,
    };
  }

  it('deux tentatives portant la même clé convergent sur une seule ligne', async () => {
    const db = await getDb();
    const idempotencyKey = `test-idempotency-${randomUUID()}`;

    const first = await enqueueNotificationDelivery(db, input(), idempotencyKey);
    cleanupIds.push(first.id);
    const second = await enqueueNotificationDelivery(db, input(), idempotencyKey);

    expect(second.id).toBe(first.id);
    const rows = (await db.query(
      'SELECT COUNT(*) AS total FROM planning_notification_outbox WHERE idempotency_key = ?',
      [idempotencyKey],
    )) as Array<{ total: number | string }>;
    expect(Number(rows[0]?.total)).toBe(1);
  });

  it('deux clés distinctes produisent deux lignes distinctes', async () => {
    const db = await getDb();
    const keyA = `test-idempotency-${randomUUID()}`;
    const keyB = `test-idempotency-${randomUUID()}`;

    const first = await enqueueNotificationDelivery(db, input(), keyA);
    const second = await enqueueNotificationDelivery(db, input(), keyB);
    cleanupIds.push(first.id, second.id);

    expect(second.id).not.toBe(first.id);
  });

  it('sans clé d\'idempotence, chaque appel crée une nouvelle ligne (comportement hors publication inchangé)', async () => {
    const db = await getDb();

    const first = await enqueueNotificationDelivery(db, input());
    const second = await enqueueNotificationDelivery(db, input());
    cleanupIds.push(first.id, second.id);

    expect(second.id).not.toBe(first.id);
  });
});
