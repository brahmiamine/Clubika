import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { getSessionUser } from '@/lib/auth/session';
import { runWithClubId } from '@/lib/auth/club-context';
import { getPlanningEventSnapshot } from '@/lib/planning/event-store';
import { savePublishedPlanning } from '@/lib/planning/published-planning';
import { POST as createEntrainement } from '@/app/api/entrainements/route';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

function respondRequest(body: unknown, token: string) {
  return new NextRequest('http://localhost/api/me/assignments/respond', {
    method: 'POST',
    headers: { cookie: `session_token=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!dbAvailable)('POST /api/me/assignments/respond (issue #155)', () => {
  it('lets an assigned encadrant accept, then decline, a published assignment', async () => {
    // Club isolé : savePublishedPlanning réécrit le snapshot publié entier du club, ce qui
    // collisionnerait avec d'autres tests d'intégration tournant en parallèle sur le club
    // par défaut.
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId });
    const encadrant = await createTestUserAndSession('dirigeant', { clubId }, ['encadrant']);
    let createdId: string | null = null;

    try {
      const db = await getDb();
      const adminUser = await getSessionUser(admin.token);
      if (!adminUser) throw new Error('admin session introuvable');

      const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const date = `${String(futureDate.getDate()).padStart(2, '0')}/${String(futureDate.getMonth() + 1).padStart(2, '0')}/${futureDate.getFullYear()}`;

      const createResponse = await createEntrainement(new NextRequest('http://localhost/api/entrainements', {
        method: 'POST',
        headers: { cookie: `session_token=${admin.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          time: '10:00',
          lieu: 'Terrain test',
          categorie: 'U13',
          encadrants: [{ nom: encadrant.user.nom, personId: encadrant.user.id, status: 'pending' }],
        }),
      }));
      expect(createResponse.status).toBe(200);
      createdId = (await createResponse.json()).entrainement.id as string;

      // Le contexte club ambiant n'est fiable que pendant l'exécution d'une requête ; on le
      // fixe explicitement ici plutôt que de compter sur ce que le dernier appel de route a
      // laissé derrière lui.
      await runWithClubId(clubId, async () => {
        const liveSnapshot = await getPlanningEventSnapshot(db, 'entrainement', createdId!);
        if (!liveSnapshot) throw new Error('snapshot introuvable');
        await savePublishedPlanning(db, adminUser, [liveSnapshot]);
      });

      // Un utilisateur voit uniquement le publié et confirme son affectation.
      const acceptResponse = await POST(respondRequest({
        eventId: createdId,
        eventType: 'entrainement',
        role: 'encadrant',
        status: 'accepted',
      }, encadrant.token));
      expect(acceptResponse.status).toBe(200);
      expect((await acceptResponse.json()).status).toBe('accepted');

      // La confirmation est figée (issue #43) : une deuxième réponse (même différente) est
      // acceptée par la route (pas de contrôle "déjà répondu" ici) mais republier ne doit
      // jamais s'appuyer sur le brouillon live modifié entre-temps : on vérifie que le
      // statut publié a bien changé côté snapshot publié.
      const publishedAfterAccept = await runWithClubId(clubId, () => getPlanningEventSnapshot(db, 'entrainement', createdId!));
      // Refus avec motif requis.
      const declineResponse = await POST(respondRequest({
        eventId: createdId,
        eventType: 'entrainement',
        role: 'encadrant',
        status: 'declined',
        declineReason: 'personal',
      }, encadrant.token));
      expect(declineResponse.status).toBe(200);
      const declineBody = await declineResponse.json();
      expect(declineBody.status).toBe('declined');
      expect(declineBody.declineReason).toBe('personal');
      expect(declineBody).not.toHaveProperty('declineComment');
      expect(publishedAfterAccept).not.toBeNull();

      const liveAfterDecline = await runWithClubId(clubId, () => getPlanningEventSnapshot(db, 'entrainement', createdId!));
      expect(liveAfterDecline?.assignments.encadrant ?? []).toEqual([]);
      expect(liveAfterDecline?.planningStatus).toBe('modified');
    } finally {
      const db = await getDb();
      if (createdId) {
        await db.query('DELETE FROM planning_records WHERE club_id = ? AND kind = ?', [admin.user.clubId, 'published-planning']);
        await db.getRepository('Entrainement').delete({ id: createdId });
        await db.getRepository('MatchAuditLog').delete({ entityId: createdId });
      }
      await encadrant.cleanup();
      await admin.cleanup();
    }
  });

  it('rejects a medical decline reason with 400 (issue #7)', async () => {
    const encadrant = await createTestUserAndSession('dirigeant', undefined, ['encadrant']);
    try {
      const response = await POST(respondRequest({
        eventId: 'whatever',
        eventType: 'entrainement',
        role: 'encadrant',
        status: 'declined',
        declineReason: 'injury',
        declineComment: 'ne doit pas être persisté',
      }, encadrant.token));
      expect(response.status).toBe(400);
      const body = await response.json() as { error?: string };
      expect(body.error).toMatch(/médicaux/i);
    } finally {
      await encadrant.cleanup();
    }
  });
});
