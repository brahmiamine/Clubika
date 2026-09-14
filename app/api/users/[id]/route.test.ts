import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { getSessionUser } from '@/lib/auth/session';
import type { NotificationEntity } from '@/lib/db/schemas';
import { DELETE, PUT } from './route';
import { POST as postEntrainement } from '@/app/api/entrainements/route';

const dbAvailable = await isDbAvailable();

function putRequest(body: Record<string, unknown>, token: string) {
  return new NextRequest('http://localhost/api/users/1', {
    method: 'PUT',
    headers: { cookie: `session_token=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function deleteRequest(token: string) {
  return new NextRequest('http://localhost/api/users/1', {
    method: 'DELETE',
    headers: { cookie: `session_token=${token}` },
  });
}

describe.skipIf(!dbAvailable)('PUT /api/users/[id] — alerte de désactivation (issue #206)', () => {
  it("notifie les administrateurs quand un dirigeant désactivé a une affectation future", async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const encadrant = await createTestUserAndSession('dirigeant', { clubId, nom: `Encadrant Futur ${randomBytes(3).toString('hex')}` }, ['encadrant']);
    let draftId: string | null = null;

    try {
      const db = await getDb();

      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const dateStr = `${String(futureDate.getDate()).padStart(2, '0')}/${String(futureDate.getMonth() + 1).padStart(2, '0')}/${futureDate.getFullYear()}`;

      const createResponse = await postEntrainement(new NextRequest('http://localhost/api/entrainements', {
        method: 'POST',
        headers: { cookie: `session_token=${admin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateStr,
          time: '10:00',
          lieu: 'Terrain futur',
          categorie: 'U13',
          encadrants: [{ nom: encadrant.user.nom, numero: '' }],
        }),
      }));
      expect(createResponse.status).toBe(200);
      const created = await createResponse.json();
      draftId = created.entrainement?.id ?? null;
      // L'encadrant doit avoir été résolu par nom (personId lié), sinon le test ne prouve rien.
      expect(created.entrainement?.encadrants?.[0]?.personId).toBe(encadrant.user.id);

      const putResponse = await PUT(
        putRequest({ active: false }, admin.token),
        { params: { id: String(encadrant.user.id) } },
      );
      expect(putResponse.status).toBe(200);

      const adminNotifications = await db.getRepository<NotificationEntity>('Notification').find({ where: { userId: admin.user.id } });
      expect(adminNotifications.some((n) => n.type === 'user-deactivated-with-assignments')).toBe(true);
    } finally {
      const db = await getDb();
      if (draftId) {
        await db.getRepository('Entrainement').delete({ id: draftId });
        await db.getRepository('MatchAuditLog').delete({ entityId: draftId });
      }
      await db.getRepository('Notification').delete({ userId: admin.user.id });
      await admin.cleanup();
      await encadrant.cleanup();
    }
  });

  it("ne notifie personne quand le dirigeant désactivé n'a aucune affectation future", async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const encadrant = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);

    try {
      const db = await getDb();

      const putResponse = await PUT(
        putRequest({ active: false }, admin.token),
        { params: { id: String(encadrant.user.id) } },
      );
      expect(putResponse.status).toBe(200);

      const adminNotifications = await db.getRepository<NotificationEntity>('Notification').find({ where: { userId: admin.user.id } });
      expect(adminNotifications.some((n) => n.type === 'user-deactivated-with-assignments')).toBe(false);
    } finally {
      const db = await getDb();
      await db.getRepository('Notification').delete({ userId: admin.user.id });
      await admin.cleanup();
      await encadrant.cleanup();
    }
  });
});

describe.skipIf(!dbAvailable)('DELETE /api/users/[id] — protection des comptes référencés (issue #273)', () => {
  it('refuse de supprimer un compte affecté à un événement en brouillon', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const encadrant = await createTestUserAndSession('dirigeant', { clubId, nom: `Référencé ${randomBytes(3).toString('hex')}` }, ['encadrant']);
    let draftId: string | null = null;

    try {
      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const dateStr = `${String(futureDate.getDate()).padStart(2, '0')}/${String(futureDate.getMonth() + 1).padStart(2, '0')}/${futureDate.getFullYear()}`;
      const createResponse = await postEntrainement(new NextRequest('http://localhost/api/entrainements', {
        method: 'POST',
        headers: { cookie: `session_token=${admin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: dateStr,
          time: '10:00',
          lieu: 'Terrain référencé',
          categorie: 'U13',
          encadrants: [{ nom: encadrant.user.nom, numero: '' }],
        }),
      }));
      expect(createResponse.status).toBe(200);
      const created = await createResponse.json();
      draftId = created.entrainement?.id ?? null;
      expect(created.entrainement?.encadrants?.[0]?.personId).toBe(encadrant.user.id);

      const response = await DELETE(deleteRequest(admin.token), { params: { id: String(encadrant.user.id) } });
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body.details).toEqual(expect.arrayContaining([expect.stringContaining('brouillon')]));

      const db = await getDb();
      const stillThere = await db.getRepository('User').findOneBy({ id: encadrant.user.id });
      expect(stillThere).not.toBeNull();
    } finally {
      const db = await getDb();
      if (draftId) {
        await db.getRepository('Entrainement').delete({ id: draftId });
        await db.getRepository('MatchAuditLog').delete({ entityId: draftId });
      }
      await admin.cleanup();
      await encadrant.cleanup();
    }
  });

  it('supprime un compte sans aucune référence métier', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const encadrant = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);

    try {
      const response = await DELETE(deleteRequest(admin.token), { params: { id: String(encadrant.user.id) } });
      expect(response.status).toBe(200);

      const db = await getDb();
      const gone = await db.getRepository('User').findOneBy({ id: encadrant.user.id });
      expect(gone).toBeNull();
    } finally {
      await admin.cleanup();
      // Le compte encadrant a déjà été supprimé par le handler ; cleanup() ne doit pas
      // échouer si sa ligne n'existe plus (delete est idempotent côté TypeORM).
      await encadrant.cleanup();
    }
  });
});

describe.skipIf(!dbAvailable)('DELETE/PUT /api/users/[id] — invariant du dernier administrateur (issue #273)', () => {
  it('deux suppressions concurrentes ciblant chacune un administrateur différent : une seule réussit', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId });
    const adminB = await createTestUserAndSession('admin', { clubId });

    try {
      const [responseA, responseB] = await Promise.all([
        DELETE(deleteRequest(adminA.token), { params: { id: String(adminA.user.id) } }),
        DELETE(deleteRequest(adminA.token), { params: { id: String(adminB.user.id) } }),
      ]);
      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const db = await getDb();
      const remainingAdmins = await db.getRepository('User').find({ where: { clubId, active: true, accessRole: 'admin' } });
      expect(remainingAdmins).toHaveLength(1);
    } finally {
      await adminA.cleanup();
      await adminB.cleanup();
    }
  });

  it('deux démotions concurrentes ciblant chacune un administrateur différent : une seule réussit', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId });
    const adminB = await createTestUserAndSession('admin', { clubId });

    try {
      const [responseA, responseB] = await Promise.all([
        PUT(putRequest({ accessRole: 'dirigeant' }, adminA.token), { params: { id: String(adminA.user.id) } }),
        PUT(putRequest({ accessRole: 'dirigeant' }, adminA.token), { params: { id: String(adminB.user.id) } }),
      ]);
      const statuses = [responseA.status, responseB.status].sort();
      expect(statuses).toEqual([200, 400]);

      const db = await getDb();
      const remainingAdmins = await db.getRepository('User').find({ where: { clubId, active: true, accessRole: 'admin' } });
      expect(remainingAdmins).toHaveLength(1);
    } finally {
      await adminA.cleanup();
      await adminB.cleanup();
    }
  });
});

describe.skipIf(!dbAvailable)('PUT /api/users/[id] — révocation à l\'élévation de rôle (issue #29)', () => {
  it('révoque les sessions existantes quand un dirigeant devient administrateur', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const dirigeant = await createTestUserAndSession('dirigeant', { clubId });
    try {
      expect(await getSessionUser(dirigeant.token)).not.toBeNull();
      const response = await PUT(
        putRequest({ accessRole: 'admin' }, admin.token),
        { params: { id: String(dirigeant.user.id) } },
      );
      expect(response.status).toBe(200);
      expect(await getSessionUser(dirigeant.token)).toBeNull();
    } finally {
      await admin.cleanup();
      await dirigeant.cleanup();
    }
  });
});
