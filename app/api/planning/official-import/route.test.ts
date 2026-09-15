import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { POST } from './route';

const dbAvailable = await isDbAvailable();

function requestFor(body: unknown, token: string) {
  return new NextRequest('http://localhost/api/planning/official-import', {
    method: 'POST',
    headers: {
      cookie: `session_token=${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!dbAvailable)('POST /api/planning/official-import (issue #5)', () => {
  it('importe un CSV attesté et refuse SportCorico', async () => {
    const { token, cleanup, user } = await createTestUserAndSession('admin');
    let ids: string[] = [];
    try {
      const csv = 'date,time,localTeam,awayTeam,venue,competition\n21/09/2026,15:00,Equipe A,Equipe B,domicile,Championnat';
      const response = await POST(requestFor({ csvText: csv, rightsAttested: true }, token));
      expect(response.status).toBe(200);
      const payload = await response.json();
      ids = payload.ids as string[];
      expect(payload.createdCount).toBe(1);

      const db = await getDb();
      const stored = await db.getRepository('MatchOfficial').findOneBy({ id: ids[0], clubId: user.clubId });
      expect(stored).toBeTruthy();
      expect((stored?.payload as { importProvenance?: { provider?: string } }).importProvenance?.provider).toBe('csv');

      const rejected = await POST(requestFor({
        csvText: 'date,time,localTeam,awayTeam,venue\n21/09/2026,15:00,A,B,https://www.sportcorico.com/x',
        rightsAttested: true,
      }, token));
      expect(rejected.status).toBe(400);

      const unattested = await POST(requestFor({ csvText: csv, rightsAttested: false }, token));
      expect(unattested.status).toBe(400);
    } finally {
      if (ids.length > 0) {
        const db = await getDb();
        for (const id of ids) {
          await db.getRepository('MatchExtra').delete({ matchId: id, clubId: user.clubId });
          await db.getRepository('MatchOfficial').delete({ id, clubId: user.clubId });
          await db.getRepository('MatchAuditLog').delete({ entityId: id, clubId: user.clubId });
        }
      }
      await cleanup();
    }
  });
});
