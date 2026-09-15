import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import type { MatchAuditLogEntity } from '@/lib/db/schemas';
import { GET } from './route';
import { auditBlobContainsNeedle } from '@/lib/audit/minimize';

const dbAvailable = await isDbAvailable();

function auditRequest(token: string | undefined, matchId: string) {
  return new NextRequest(`http://localhost/api/matches/${matchId}/audit-log`, {
    method: 'GET',
    headers: token ? { cookie: `session_token=${token}` } : {},
  });
}

describe.skipIf(!dbAvailable)('/api/matches/[id]/audit-log (integration)', () => {
  const entityId = `test-audit-route-${Date.now()}`;

  afterEach(async () => {
    const db = await getDb();
    await db.getRepository('MatchAuditLog').delete({ entityId });
  });

  it('returns 401 without a session', async () => {
    const response = await GET(auditRequest(undefined, entityId), { params: { id: entityId } });
    expect(response.status).toBe(401);
  });

  it('returns 403 for a read-only role (issue #126)', async () => {
    const { token, cleanup } = await createTestUserAndSession('dirigeant', undefined, ['encadrant']);
    try {
      const response = await GET(auditRequest(token, entityId), { params: { id: entityId } });
      expect(response.status).toBe(403);
    } finally {
      await cleanup();
    }
  });

  it('an admin only reads the audit entries of their own club (issue #126)', async () => {
    const db = await getDb();
    const { token, cleanup } = await createTestUserAndSession('admin', { clubId: 'club-a' });
    try {
      // Entrées des deux clubs sur le même identifiant d'entité.
      await db.getRepository<MatchAuditLogEntity>('MatchAuditLog').save([
        {
          clubId: 'club-a',
          entityType: 'MatchOfficial',
          entityId,
          action: 'update',
          userId: null,
          userEmail: null,
          userNom: null,
          before: null,
          after: { confirmed: true },
        },
        {
          clubId: 'club-b',
          entityType: 'MatchOfficial',
          entityId,
          action: 'update',
          userId: null,
          userEmail: null,
          userNom: null,
          before: null,
          after: { confirmed: false },
        },
      ]);

      const response = await GET(auditRequest(token, entityId), { params: { id: entityId } });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.entries).toHaveLength(1);
      expect(payload.entries[0]?.clubId).toBe('club-a');
      expect(payload.entries[0]?.after).toEqual({ confirmed: true });
      expect(payload.entries[0]?.actorLabel).toBe('Système');
      expect(payload.entries[0]).not.toHaveProperty('userEmail');
      expect(payload.entries[0]).not.toHaveProperty('userNom');
    } finally {
      await cleanup();
    }
  });

  it('strips leftover personal content from the admin DTO (issue #20)', async () => {
    const db = await getDb();
    const { token, cleanup, user } = await createTestUserAndSession('admin', { clubId: 'club-a' });
    const sentinels = ['sentinel.api@example.test', 'Sentinel Api', 'Texte API sentinelle'];
    try {
      await db.getRepository<MatchAuditLogEntity>('MatchAuditLog').save({
        clubId: user.clubId,
        entityType: 'PlanningCollaboration',
        entityId,
        action: 'report',
        userId: user.id,
        userEmail: sentinels[0],
        userNom: sentinels[1],
        before: null,
        after: { text: sentinels[2], category: 'other', authorUserId: user.id, authorName: sentinels[1] },
      });

      const response = await GET(auditRequest(token, entityId), { params: { id: entityId } });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload.entries).toHaveLength(1);
      expect(payload.entries[0]?.actorLabel).toBe(`Utilisateur #${user.id}`);
      expect(payload.entries[0]?.after).toEqual({ category: 'other', authorUserId: user.id });
      expect(payload.entries[0]).not.toHaveProperty('userEmail');
      expect(payload.entries[0]).not.toHaveProperty('userNom');
      expect(auditBlobContainsNeedle(payload, sentinels)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  it('returns 400 for an empty match id', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin');
    try {
      const response = await GET(auditRequest(token, ' '), { params: { id: ' ' } });
      expect(response.status).toBe(400);
    } finally {
      await cleanup();
    }
  });
});
