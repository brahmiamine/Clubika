import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { setCurrentClubId } from '@/lib/auth/club-context';
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

function deleteRequest(token: string, search = '') {
  return new NextRequest(`http://localhost/api/users/1${search}`, {
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

describe.skipIf(!dbAvailable)('DELETE /api/users/[id] — fermeture et anonymisation (issue #11)', () => {
  it('anonymise un compte affecté à un événement en brouillon au lieu de renvoyer 409', async () => {
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

      const dryRun = await DELETE(deleteRequest(admin.token, '?dryRun=true'), { params: { id: String(encadrant.user.id) } });
      expect(dryRun.status).toBe(200);
      const db = await getDb();
      const before = await db.getRepository('User').findOneBy({ id: encadrant.user.id });
      expect(before?.email).toBe(encadrant.user.email);

      const response = await DELETE(deleteRequest(admin.token), { params: { id: String(encadrant.user.id) } });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        closure: { preview: { displayName: string; retained: Array<{ category: string; kept: boolean }> } };
      };
      expect(body.closure.preview.displayName).toBe('Utilisateur supprimé');
      expect(body.closure.preview.retained.some((item) => item.category === 'planning-history' && item.kept)).toBe(true);

      const stub = await db.getRepository('User').findOneBy({ id: encadrant.user.id });
      expect(stub).not.toBeNull();
      expect(stub?.nom).toBe('Utilisateur supprimé');
      expect(stub?.email).toBe(`closed.${encadrant.user.id}@invalid.local`);
      expect(stub?.telephone).toBeNull();
      expect(stub?.active).toBe(false);
      expect(stub?.closedAt).not.toBeNull();
      expect(stub?.passwordHash).toBe('closed:revoked');

      const draft = await db.getRepository('Entrainement').findOneBy({ id: draftId });
      expect(JSON.stringify(draft?.payload)).toContain('Utilisateur supprimé');
      expect(JSON.stringify(draft?.payload)).not.toContain(encadrant.user.nom);

      const again = await DELETE(deleteRequest(admin.token), { params: { id: String(encadrant.user.id) } });
      expect(again.status).toBe(200);
      const againBody = await again.json() as { closure: { alreadyClosed: boolean; closedAt: string } };
      expect(againBody.closure.alreadyClosed).toBe(true);
    } finally {
      const db = await getDb();
      if (draftId) {
        await db.getRepository('Entrainement').delete({ id: draftId });
        await db.getRepository('MatchAuditLog').delete({ entityId: draftId });
      }
      await db.query('DELETE FROM account_closures WHERE user_id = ?', [encadrant.user.id]);
      await admin.cleanup();
      await encadrant.cleanup();
    }
  });

  it('ferme un compte sans référence métier en conservant un stub anonymisé', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const encadrant = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    const previousIcal = encadrant.user.icalToken;

    try {
      const response = await DELETE(deleteRequest(admin.token), { params: { id: String(encadrant.user.id) } });
      expect(response.status).toBe(200);

      const db = await getDb();
      const stub = await db.getRepository('User').findOneBy({ id: encadrant.user.id });
      expect(stub).not.toBeNull();
      expect(stub?.nom).toBe('Utilisateur supprimé');
      expect(stub?.icalToken).not.toBe(previousIcal);
      expect(stub?.email).not.toContain('@example.com');
    } finally {
      const db = await getDb();
      await db.query('DELETE FROM account_closures WHERE user_id = ?', [encadrant.user.id]);
      await admin.cleanup();
      await encadrant.cleanup();
    }
  });

  it('rejoue la transaction si une étape ultérieure échoue', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const encadrant = await createTestUserAndSession('dirigeant', { clubId, email: `keep-${randomBytes(4).toString('hex')}@example.com` }, ['encadrant']);

    try {
      const db = await getDb();
      const originalEmail = encadrant.user.email;
      setCurrentClubId(clubId);
      await expect(db.transaction(async (manager) => {
        const { closeAccount, countLockedActiveAdmins, lockTargetAndActiveAdmins } = await import('@/lib/account-closure/close-account');
        const locked = await lockTargetAndActiveAdmins(manager, clubId, encadrant.user.id);
        const target = locked.find((row) => row.id === encadrant.user.id);
        expect(target).toBeDefined();
        await closeAccount(manager, {
          target: target!,
          processedByUserId: admin.user.id,
          processedByRole: 'admin',
          activeAdminCount: countLockedActiveAdmins(locked),
        });
        throw new Error('boom-after-close');
      })).rejects.toThrow('boom-after-close');

      const still = await db.getRepository('User').findOneBy({ id: encadrant.user.id });
      expect(still?.email).toBe(originalEmail);
      expect(still?.closedAt).toBeNull();
      expect(still?.nom).toBe(encadrant.user.nom);
    } finally {
      await admin.cleanup();
      await encadrant.cleanup();
    }
  });

  it('n’anonymise pas un homonyme d’un autre club', async () => {
    const clubA = `test-club-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-${randomBytes(6).toString('hex')}`;
    const adminA = await createTestUserAndSession('admin', { clubId: clubA });
    const twinA = await createTestUserAndSession('dirigeant', { clubId: clubA, nom: 'Jumeau Clubika' }, ['encadrant']);
    const twinB = await createTestUserAndSession('dirigeant', { clubId: clubB, nom: 'Jumeau Clubika' }, ['encadrant']);

    try {
      const response = await DELETE(deleteRequest(adminA.token), { params: { id: String(twinA.user.id) } });
      expect(response.status).toBe(200);
      const db = await getDb();
      const other = await db.getRepository('User').findOneBy({ id: twinB.user.id });
      expect(other?.nom).toBe('Jumeau Clubika');
      expect(other?.email).toBe(twinB.user.email);
      expect(other?.closedAt).toBeNull();
    } finally {
      const db = await getDb();
      await db.query('DELETE FROM account_closures WHERE user_id = ?', [twinA.user.id]);
      await adminA.cleanup();
      await twinA.cleanup();
      await twinB.cleanup();
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
