import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { NotificationEntity, UserEntity } from '@/lib/db/schemas';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

function postRequest(token: string) {
  return new NextRequest('http://localhost/api/users/1/minor-erroneous', {
    method: 'POST',
    headers: { cookie: `session_token=${token}` },
  });
}

describe.skipIf(!dbAvailable)('POST /api/users/[id]/minor-erroneous — compte mineur créé par erreur (issue #18)', () => {
  it('suspend, notifie les administrateurs puis efface le compte', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const minor = await createTestUserAndSession('dirigeant', { clubId, nom: `Mineur ${randomBytes(3).toString('hex')}` }, ['encadrant']);

    try {
      const db = await getDb();

      const response = await POST(postRequest(admin.token), { params: { id: String(minor.user.id) } });
      expect(response.status).toBe(200);
      const body = await response.json() as { closure: { userId: number; alreadyClosed: boolean } };
      expect(body.closure.userId).toBe(minor.user.id);
      expect(body.closure.alreadyClosed).toBe(false);

      // Suspension + effacement : le compte n'est plus actif, l'identité est
      // anonymisée et la fermeture est tracée sous ce motif distinct.
      const reloaded = await db.getRepository<UserEntity>('User').findOneBy({ id: minor.user.id });
      expect(reloaded?.active).toBe(false);
      expect(reloaded?.closedAt).not.toBeNull();
      expect(reloaded?.nom).toBe('Utilisateur supprimé');
      expect(reloaded?.email).not.toBe(minor.user.email);

      const [closureRow] = await db.query(
        'SELECT processed_by_role FROM account_closures WHERE user_id = ?',
        [minor.user.id],
      ) as Array<{ processed_by_role: string }>;
      expect(closureRow?.processed_by_role).toBe('minor-erroneous');

      // Toutes les sessions du compte suspendu sont révoquées.
      const sessions = await db.query(
        'SELECT revokedAt FROM user_sessions WHERE userId = ?',
        [minor.user.id],
      ) as Array<{ revokedAt: string | null }>;
      expect(sessions.every((session) => session.revokedAt !== null)).toBe(true);

      // Information : les administrateurs actifs du club reçoivent une notification.
      const adminNotifications = await db.getRepository<NotificationEntity>('Notification').find({ where: { userId: admin.user.id } });
      expect(adminNotifications.some((n) => n.type === 'minor-account-erroneous-closure')).toBe(true);
    } finally {
      const db = await getDb();
      await db.getRepository('Notification').delete({ userId: admin.user.id });
      await db.query('DELETE FROM account_closures WHERE user_id = ?', [minor.user.id]);
      await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :userId', { userId: minor.user.id }).execute();
      await db.getRepository('User').delete({ id: minor.user.id });
      await admin.cleanup();
    }
  });

  it('refuse aux non-administrateurs', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const encadrant = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    const target = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    try {
      const response = await POST(postRequest(encadrant.token), { params: { id: String(target.user.id) } });
      expect(response.status).toBe(403);
    } finally {
      await encadrant.cleanup();
      await target.cleanup();
    }
  });

  it('refuse de fermer le dernier administrateur actif par ce chemin', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    try {
      const response = await POST(postRequest(admin.token), { params: { id: String(admin.user.id) } });
      expect(response.status).toBe(400);
      const db = await getDb();
      const reloaded = await db.getRepository<UserEntity>('User').findOneBy({ id: admin.user.id });
      expect(reloaded?.active).toBe(true);
      expect(reloaded?.closedAt).toBeNull();
    } finally {
      await admin.cleanup();
    }
  });

  it('isole les clubs : un admin ne peut pas cibler un compte d\'un autre club', async () => {
    const clubA = `test-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-b-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId: clubA });
    const targetB = await createTestUserAndSession('dirigeant', { clubId: clubB }, ['encadrant']);
    try {
      const response = await POST(postRequest(adminA.token), { params: { id: String(targetB.user.id) } });
      expect(response.status).toBe(404);
      const db = await getDb();
      const reloaded = await db.getRepository<UserEntity>('User').findOneBy({ id: targetB.user.id });
      expect(reloaded?.active).toBe(true);
      expect(reloaded?.closedAt).toBeNull();
    } finally {
      await adminA.cleanup();
      await targetB.cleanup();
    }
  });

  it('est idempotent pour un compte déjà fermé', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const minor = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    try {
      const db = await getDb();
      const first = await POST(postRequest(admin.token), { params: { id: String(minor.user.id) } });
      expect(first.status).toBe(200);

      const second = await POST(postRequest(admin.token), { params: { id: String(minor.user.id) } });
      expect(second.status).toBe(200);
      const secondBody = await second.json() as { closure: { alreadyClosed: boolean } };
      expect(secondBody.closure.alreadyClosed).toBe(true);

      await db.getRepository('Notification').delete({ userId: admin.user.id });
      await db.query('DELETE FROM account_closures WHERE user_id = ?', [minor.user.id]);
      await db.getRepository('UserSession').createQueryBuilder().delete().where('userId = :userId', { userId: minor.user.id }).execute();
      await db.getRepository('User').delete({ id: minor.user.id });
    } finally {
      await admin.cleanup();
    }
  });
});
