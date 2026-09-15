import { randomBytes } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { savePlanningRecord } from '@/lib/planning/records';
import type { PlanningEventSnapshot } from '@/lib/planning/event-store';
import { GET, POST } from './route';
import { GET as GET_DOWNLOAD } from './[token]/route';
import { POST as postEntrainement } from '@/app/api/entrainements/route';
import { PUT as putFeatures } from '@/app/api/settings/planning-features/route';

const dbAvailable = await isDbAvailable();

function snapshot(eventId: string, overrides: Partial<PlanningEventSnapshot> = {}): PlanningEventSnapshot {
  return {
    eventId,
    eventType: 'entrainement',
    title: `Entraînement ${eventId}`,
    date: '15/09/2026',
    time: '18:00',
    durationMinutes: 90,
    location: 'Terrain A',
    planningStatus: 'published',
    event: { id: eventId, type: 'entrainement', date: '15/09/2026', time: '18:00', lieu: 'Terrain A', encadrants: [{ nom: 'Sentinel Coach', numero: '+33600000000' }] } as unknown as PlanningEventSnapshot['event'],
    extras: null,
    assignments: { arbitre: [], encadrant: [{ nom: 'Sentinel Coach', numero: '+33600000000' }], accompagnateur: [] },
    revision: 0,
    ...overrides,
  } as PlanningEventSnapshot;
}

function postRequest(token: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/planning/export', {
    method: 'POST',
    headers: { cookie: `session_token=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/planning/export (issue #33)', () => {
  it('rejects direct GET without a download token', async () => {
    const response = await GET();
    expect(response.status).toBe(405);
  });
});

describe.skipIf(!dbAvailable)('POST /api/planning/export — projection et lien hashé (issue #33)', () => {
  const CLUB_ID = `test-club-${randomBytes(6).toString('hex')}`;
  const publishedId = `published-planning:${CLUB_ID}`;

  afterEach(async () => {
    const db = await getDb();
    await db.query('DELETE FROM planning_records WHERE club_id = ?', [CLUB_ID]);
    await db.query('DELETE FROM club_tenants WHERE id = ?', [CLUB_ID]);
  });

  it('projects operational fields only and never returns raw events/extras', async () => {
    const db = await getDb();
    const { token, cleanup } = await createTestUserAndSession('admin', { clubId: CLUB_ID });
    let draftId: string | null = null;

    try {
      await savePlanningRecord(db, {
        id: publishedId,
        clubId: CLUB_ID,
        kind: 'published-planning',
        payload: {
          schemaVersion: 1,
          publishedAt: new Date().toISOString(),
          publishedByUserId: 0,
          events: [
            snapshot('kept'),
            snapshot('hidden', { planningStatus: 'cancelled' }),
          ],
        },
      });

      const draftResponse = await postEntrainement(new NextRequest('http://localhost/api/entrainements', {
        method: 'POST',
        headers: { cookie: `session_token=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: '20/09/2026',
          time: '10:00',
          lieu: 'Terrain brouillon',
          categorie: 'U13',
          encadrants: [],
        }),
      }));
      draftId = (await draftResponse.json()).entrainement?.id ?? null;

      const created = await POST(postRequest(token, { format: 'json' }));
      expect(created.status).toBe(200);
      const ticket = await created.json() as { token: string; rowCount: number };
      expect(ticket.token).toBeTruthy();
      expect(JSON.stringify(ticket)).not.toContain('Sentinel Coach');
      expect(JSON.stringify(ticket)).not.toContain('+33600000000');

      const download = await GET_DOWNLOAD(
        new NextRequest(`http://localhost/api/planning/export/${ticket.token}`, {
          headers: { cookie: `session_token=${token}` },
        }),
        { params: Promise.resolve({ token: ticket.token }) },
      );
      expect(download.status).toBe(200);
      expect(download.headers.get('Cache-Control')).toContain('no-store');
      expect(download.headers.get('Content-Disposition')).toContain('planning-export.json');
      const body = await download.json() as { rows: Array<Record<string, string>>; events?: unknown; extras?: unknown };
      expect(body.events).toBeUndefined();
      expect(body.extras).toBeUndefined();
      expect(body.rows).toHaveLength(1);
      const dumped = JSON.stringify(body);
      expect(dumped).not.toContain('Sentinel Coach');
      expect(dumped).not.toContain('+33600000000');
      expect(dumped).not.toContain('rawText');
      expect(body.rows[0]?.location).toBe('Terrain A');

      const replay = await GET_DOWNLOAD(
        new NextRequest(`http://localhost/api/planning/export/${ticket.token}`, {
          headers: { cookie: `session_token=${token}` },
        }),
        { params: Promise.resolve({ token: ticket.token }) },
      );
      expect(replay.status).toBe(404);

      const audits = await db.query(
        `SELECT payload FROM planning_records WHERE club_id = ? AND kind = 'export-audit'`,
        [CLUB_ID],
      ) as Array<{ payload: string }>;
      expect(audits.length).toBeGreaterThan(0);
      const audit = String(audits[0]?.payload ?? '');
      expect(audit).not.toContain('Sentinel Coach');
      expect(audit).not.toContain('admin@');
    } finally {
      if (draftId) {
        await db.getRepository('Entrainement').delete({ id: draftId });
        await db.getRepository('MatchAuditLog').delete({ entityId: draftId });
      }
      await cleanup();
    }
  });

  it('rejects identity columns without purpose and another tenant download', async () => {
    const otherClub = `test-club-${randomBytes(6).toString('hex')}`;
    const admin = await createTestUserAndSession('admin', { clubId: CLUB_ID });
    const other = await createTestUserAndSession('admin', { clubId: otherClub });
    const dirigeant = await createTestUserAndSession('dirigeant', { clubId: CLUB_ID }, ['encadrant']);
    try {
      const forbidden = await POST(postRequest(admin.token, {
        format: 'csv',
        columns: ['arbitreTouche'],
        includeIdentities: true,
      }));
      expect(forbidden.status).toBe(400);

      const banned = await POST(postRequest(admin.token, { columns: ['rawText'] }));
      expect(banned.status).toBe(400);

      const asMember = await POST(postRequest(dirigeant.token, { format: 'csv' }));
      expect(asMember.status).toBe(403);

      await savePlanningRecord(await getDb(), {
        id: publishedId,
        clubId: CLUB_ID,
        kind: 'published-planning',
        payload: { schemaVersion: 1, events: [snapshot('kept')] },
      });
      const created = await POST(postRequest(admin.token, { format: 'csv' }));
      const ticket = await created.json() as { token: string };
      const stolen = await GET_DOWNLOAD(
        new NextRequest(`http://localhost/api/planning/export/${ticket.token}`, {
          headers: { cookie: `session_token=${other.token}` },
        }),
        { params: Promise.resolve({ token: ticket.token }) },
      );
      expect(stolen.status).toBe(404);
    } finally {
      const db = await getDb();
      await db.query('DELETE FROM club_tenants WHERE id = ?', [otherClub]);
      await admin.cleanup();
      await other.cleanup();
      await dirigeant.cleanup();
    }
  });

  it('returns 409 when mass export is disabled for the tenant', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin', { clubId: CLUB_ID });
    try {
      const updated = await putFeatures(new NextRequest('http://localhost/api/settings/planning-features', {
        method: 'PUT',
        headers: { cookie: `session_token=${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ features: { massExport: false } }),
      }));
      expect(updated.status).toBe(200);
      const response = await POST(postRequest(token, { format: 'csv' }));
      expect(response.status).toBe(409);
    } finally {
      await cleanup();
    }
  });
});
