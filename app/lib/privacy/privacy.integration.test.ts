import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { hashPrivacyEmail, hashPrivacyToken } from '@/lib/privacy/catalog';
import { exportContainsForbiddenNeedles } from '@/lib/privacy/export';
import { POST as postMyPrivacy } from '@/app/api/me/privacy/route';
import { PATCH as patchContact } from '@/app/api/me/privacy/contact/route';
import { POST as postExport } from '@/app/api/me/privacy/export/route';
import { GET as getExport } from '@/app/api/privacy/exports/[token]/route';
import { POST as postPublic } from '@/app/api/public/privacy-requests/route';
import { GET as listClubRequests } from '@/app/api/club/privacy-requests/route';
import { PATCH as patchClubRequest } from '@/app/api/club/privacy-requests/[id]/route';

const dbAvailable = await isDbAvailable();

function req(url: string, token: string | undefined, body?: unknown, method = 'POST') {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      ...(token ? { cookie: `session_token=${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe.skipIf(!dbAvailable)('exercice des droits RGPD (issue #22)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const db = await getDb();
    await db.query('DELETE FROM privacy_export_tokens');
    await db.query('DELETE FROM privacy_contact_changes');
    await db.query('DELETE FROM privacy_requests');
    while (cleanups.length) {
      await cleanups.pop()?.();
    }
  });

  it('exporte uniquement les données du demandeur, sans secrets ni tiers', async () => {
    const subject = await createTestUserAndSession('dirigeant', { telephone: '0600000000' });
    const other = await createTestUserAndSession('dirigeant', { clubId: subject.user.clubId, nom: 'Autre Personne', email: `other-${Date.now()}@example.com` });
    cleanups.push(subject.cleanup, other.cleanup);

    const issued = await postExport(req('/api/me/privacy/export', subject.token, {}));
    expect(issued.status).toBe(200);
    const payload = await issued.json() as { token: string; downloadPath: string };
    const download = await getExport(req(`${payload.downloadPath}?format=json`, undefined, undefined, 'GET'), { params: { token: payload.token } });
    expect(download.status).toBe(200);
    expect(download.headers.get('cache-control')).toContain('no-store');
    const body = await download.json() as { account: { email: string; id: number } };
    expect(body.account.email).toBe(subject.user.email);
    expect(body.account.id).toBe(subject.user.id);
    expect(exportContainsForbiddenNeedles(body, [other.user.email, other.user.nom, 'passwordHash', 'icalToken'])).toBe(false);

    const reused = await getExport(req(`${payload.downloadPath}?format=json`, undefined, undefined, 'GET'), { params: { token: payload.token } });
    expect(reused.status).toBe(410);
  });

  it('isole la file admin par club et refuse un e-mail déjà pris', async () => {
    const adminA = await createTestUserAndSession('admin', { clubId: 'club-a' });
    const adminB = await createTestUserAndSession('admin', { clubId: 'club-b' });
    const userA = await createTestUserAndSession('dirigeant', { clubId: 'club-a' });
    cleanups.push(adminA.cleanup, adminB.cleanup, userA.cleanup);

    await postMyPrivacy(req('/api/me/privacy', userA.token, { type: 'restriction' }));
    const listA = await listClubRequests(req('/api/club/privacy-requests', adminA.token, undefined, 'GET'));
    const listB = await listClubRequests(req('/api/club/privacy-requests', adminB.token, undefined, 'GET'));
    const payloadA = await listA.json() as { requests: Array<{ clubId: string; subjectUserId: number }> };
    const payloadB = await listB.json() as { requests: Array<{ clubId: string }> };
    expect(payloadA.requests.some((row) => row.subjectUserId === userA.user.id)).toBe(true);
    expect(payloadB.requests.some((row) => (row as { subjectUserId?: number }).subjectUserId === userA.user.id)).toBe(false);

    const conflict = await patchContact(req('/api/me/privacy/contact', userA.token, { email: adminA.user.email }, 'PATCH'));
    expect(conflict.status).toBe(409);
  });

  it('n’enregistre pas l’e-mail en clair sur une demande publique et lie l’identité par empreinte', async () => {
    const admin = await createTestUserAndSession('admin');
    const user = await createTestUserAndSession('dirigeant', { clubId: admin.user.clubId });
    cleanups.push(admin.cleanup, user.cleanup);
    const sentinel = `public.intake.${Date.now()}@example.test`;

    const created = await postPublic(req('/api/public/privacy-requests', undefined, {
      clubId: admin.user.clubId,
      email: sentinel,
      type: 'access',
    }));
    expect(created.status).toBe(200);
    const receipt = await created.json() as { receiptId: string };
    const db = await getDb();
    const rows = await db.query('SELECT subjectEmailHash, type, status FROM privacy_requests WHERE id = ?', [receipt.receiptId]);
    expect(rows[0]?.subjectEmailHash).toBe(hashPrivacyEmail(admin.user.clubId, sentinel));
    expect(JSON.stringify(rows).toLowerCase()).not.toContain(sentinel.toLowerCase());

    const linked = await patchClubRequest(
      req(`/api/club/privacy-requests/${receipt.receiptId}`, admin.token, { claimedEmail: sentinel }, 'PATCH'),
      { params: { id: receipt.receiptId } },
    );
    expect(linked.status).toBe(200);
    const mismatch = await patchClubRequest(
      req(`/api/club/privacy-requests/${receipt.receiptId}`, admin.token, { claimedEmail: 'other@example.test' }, 'PATCH'),
      { params: { id: receipt.receiptId } },
    );
    expect(mismatch.status).toBe(409);
    expect(hashPrivacyToken('x').length).toBe(64);
  });

  it('applique une restriction sans effacer le compte', async () => {
    const admin = await createTestUserAndSession('admin');
    const user = await createTestUserAndSession('dirigeant', { clubId: admin.user.clubId });
    cleanups.push(admin.cleanup, user.cleanup);
    const created = await postMyPrivacy(req('/api/me/privacy', user.token, { type: 'restriction' }));
    const body = await created.json() as { request: { id: string } };
    const applied = await patchClubRequest(
      req(`/api/club/privacy-requests/${body.request.id}`, admin.token, { applyRestriction: true }, 'PATCH'),
      { params: { id: body.request.id } },
    );
    expect(applied.status).toBe(200);
    const db = await getDb();
    const stored = await db.getRepository('User').findOneByOrFail({ id: user.user.id });
    expect(stored.processingRestrictedAt).toBeTruthy();
    expect(stored.email).toBe(user.user.email);
    expect(stored.active).toBe(true);
  });
});
