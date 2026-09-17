import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { NotificationEntity } from '@/lib/db/schemas';
import { GET } from './route';

const dbAvailable = await isDbAvailable();

function openRequest(id: string, token?: string) {
  return new NextRequest(`http://localhost/api/notifications/${id}/open`, {
    headers: token ? { cookie: `session_token=${token}` } : {},
  });
}

async function makeNotification(userId: number, overrides: Partial<NotificationEntity> = {}) {
  const db = await getDb();
  const repo = db.getRepository<NotificationEntity>('Notification');
  return repo.save({
    userId,
    type: 'chat-mention',
    title: 'Titre sensible — jamais transmis à un canal externe',
    message: 'Contenu de discussion sensible',
    eventType: 'chat',
    eventId: 'room-secret',
    readAt: null,
    ...overrides,
  });
}

describe.skipIf(!dbAvailable)('GET /api/notifications/[id]/open (issue #27)', () => {
  it('rejects an unauthenticated request without revealing whether the id exists', async () => {
    const response = await GET(openRequest('123'), { params: { id: '123' } });
    expect(response.status).toBe(401);
  });

  it('redirects to the real destination after auth + tenant/object control, and marks the notification read', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const owner = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    const notification = await makeNotification(owner.user.id);

    try {
      const response = await GET(openRequest(String(notification.id), owner.token), { params: { id: String(notification.id) } });
      expect(response.status).toBe(302);
      const location = response.headers.get('location') ?? '';
      expect(location).toContain('/chat?roomId=room-secret');
      // Jamais le contenu sensible dans l'URL de redirection : uniquement le routage.
      expect(location).not.toContain('sensible');

      const db = await getDb();
      const updated = await db.getRepository<NotificationEntity>('Notification').findOneBy({ id: notification.id });
      expect(updated?.readAt).not.toBeNull();
    } finally {
      const db = await getDb();
      await db.getRepository('Notification').delete({ id: notification.id });
      await owner.cleanup();
    }
  });

  it('never resolves a notification owned by another account, even in the same club (multi-tenant isolation)', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const owner = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    const other = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    const notification = await makeNotification(owner.user.id);

    try {
      const response = await GET(openRequest(String(notification.id), other.token), { params: { id: String(notification.id) } });
      expect(response.status).toBe(302);
      const location = response.headers.get('location') ?? '';
      // Redirection générique, pas la destination réelle de la notification d'autrui.
      expect(location).not.toContain('roomId=room-secret');

      const db = await getDb();
      const untouched = await db.getRepository<NotificationEntity>('Notification').findOneBy({ id: notification.id });
      expect(untouched?.readAt).toBeNull();
    } finally {
      const db = await getDb();
      await db.getRepository('Notification').delete({ id: notification.id });
      await owner.cleanup();
      await other.cleanup();
    }
  });

  it('redirects to a generic inbox for an unknown or non-numeric id, without erroring', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const owner = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);

    try {
      const unknown = await GET(openRequest('999999999', owner.token), { params: { id: '999999999' } });
      expect(unknown.status).toBe(302);

      const malformed = await GET(openRequest('not-a-number', owner.token), { params: { id: 'not-a-number' } });
      expect(malformed.status).toBe(302);
    } finally {
      await owner.cleanup();
    }
  });
});
