import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { NotificationEntity } from '@/lib/db/schemas';
import { POST } from './route';
import { GET as getIndisponibilites } from '@/app/api/club/indisponibilites/route';

const dbAvailable = await isDbAvailable();

function reviewRequest(token: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/club/indisponibilites/review', {
    method: 'POST',
    headers: { cookie: `session_token=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!dbAvailable)('POST /api/club/indisponibilites/review (issue #322)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('accepte, refuse avec motif, isole les clubs et reste idempotent', async () => {
    const clubA = `test-club-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId: clubA });
    const adminB = await createTestUserAndSession('admin', { clubId: clubB });
    const dirigeant = await createTestUserAndSession(
      'dirigeant',
      {
        clubId: clubA,
        nom: `Dirigeant ${randomBytes(3).toString('hex')}`,
        indisponibilites: [
          { id: 'pending-1', type: 'day-range', dateStart: '01/10/2026', dateEnd: '02/10/2026', status: 'pending' },
          { id: 'pending-2', type: 'time-slot', date: '10/10/2026', startTime: '09:00', endTime: '11:00', status: 'pending' },
        ],
      },
      ['encadrant'],
    );
    cleanups.push(adminA.cleanup, adminB.cleanup, dirigeant.cleanup);

    const forbidden = await POST(reviewRequest(dirigeant.token, {
      userId: dirigeant.user.id,
      indisponibiliteId: 'pending-1',
      decision: 'accepted',
    }));
    expect(forbidden.status).toBe(403);

    const crossClub = await POST(reviewRequest(adminB.token, {
      userId: dirigeant.user.id,
      indisponibiliteId: 'pending-1',
      decision: 'accepted',
    }));
    expect(crossClub.status).toBe(404);

    const accepted = await POST(reviewRequest(adminA.token, {
      userId: dirigeant.user.id,
      indisponibiliteId: 'pending-1',
      decision: 'accepted',
    }));
    expect(accepted.status).toBe(200);

    const retry = await POST(reviewRequest(adminA.token, {
      userId: dirigeant.user.id,
      indisponibiliteId: 'pending-1',
      decision: 'accepted',
    }));
    expect(retry.status).toBe(200);
    expect((await retry.json() as { idempotent: boolean }).idempotent).toBe(true);

    const conflict = await POST(reviewRequest(adminA.token, {
      userId: dirigeant.user.id,
      indisponibiliteId: 'pending-1',
      decision: 'rejected',
      comment: 'trop tard',
    }));
    expect(conflict.status).toBe(409);

    const rejected = await POST(reviewRequest(adminA.token, {
      userId: dirigeant.user.id,
      indisponibiliteId: 'pending-2',
      decision: 'rejected',
      reviewCode: 'schedule_too_broad',
    }));
    expect(rejected.status).toBe(200);

    const list = await getIndisponibilites(new NextRequest('http://localhost/api/club/indisponibilites', {
      headers: { cookie: `session_token=${adminA.token}` },
    }));
    const body = await list.json() as { items: Array<{ indisponibiliteId: string; reviewStatus: string; reviewComment: string | null }> };
    expect(body.items.find((item) => item.indisponibiliteId === 'pending-1')?.reviewStatus).toBe('accepted');
    expect(body.items.find((item) => item.indisponibiliteId === 'pending-2')).toMatchObject({
      reviewStatus: 'rejected',
      reviewComment: 'Créneau trop large',
    });

    const db = await getDb();
    const notifications = await db.getRepository<NotificationEntity>('Notification').find({ where: { userId: dirigeant.user.id } });
    expect(notifications.some((item) => item.type === 'availability-reviewed')).toBe(true);
    expect(notifications.every((item) => !String(item.message ?? '').includes('Créneau trop large'))).toBe(true);
    expect(notifications.every((item) => !String(item.message ?? '').includes('trop tard'))).toBe(true);
    await db.getRepository('Notification').delete({ userId: dirigeant.user.id });
    await db.getRepository('MatchAuditLog').delete({ entityId: `${dirigeant.user.id}:pending-1` });
    await db.getRepository('MatchAuditLog').delete({ entityId: `${dirigeant.user.id}:pending-2` });
  });
});
