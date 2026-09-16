import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { isDbAvailable } from '@/lib/db/test-utils';
import { getDb } from '@/lib/db';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { GET, POST, PUT, DELETE } from './route';

const dbAvailable = await isDbAvailable();

function officielsRequest(method: string, token: string | undefined, body?: unknown, search = '') {
  return new NextRequest(`http://localhost/api/officiels${search}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      ...(token ? { cookie: `session_token=${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

describe.skipIf(!dbAvailable)('/api/officiels CRUD (integration)', () => {
  const createdNoms: string[] = [];

  afterEach(async () => {
    if (createdNoms.length === 0) return;
    const db = await getDb();
    await db.getRepository('User').createQueryBuilder().delete().where('nom IN (:...noms)', { noms: createdNoms }).execute();
    createdNoms.length = 0;
  });

  it('creates an officiel as admin, then finds it case-insensitively on delete', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin');
    try {
      const nom = `Test Officiel ${Date.now()}`;
      createdNoms.push(nom);

      const createResponse = await POST(officielsRequest('POST', token, {
        nom,
        telephone: '0600000000',
        provenance: 'responsable_club',
      }));
      expect(createResponse.status).toBe(200);

      const listResponse = await GET(officielsRequest('GET', token));
      const list = await listResponse.json();
      expect(list.officiels.some((o: { nom: string }) => o.nom === nom)).toBe(true);

      const deleteResponse = await DELETE(officielsRequest('DELETE', token, undefined, `?nom=${encodeURIComponent(nom.toUpperCase())}`));
      expect(deleteResponse.status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  it('rejects mutations from a read-only role', async () => {
    const { token, cleanup } = await createTestUserAndSession('dirigeant', undefined, ['arbitre_club']);
    try {
      const response = await POST(officielsRequest('POST', token, { nom: `Should Fail ${Date.now()}` }));
      expect(response.status).toBe(403);
    } finally {
      await cleanup();
    }
  });

  it('rejects mutations without authentication', async () => {
    const response = await PUT(officielsRequest('PUT', undefined, { nom: 'X', oldNom: 'X' }));
    expect(response.status).toBe(401);
  });

  it('refuse un téléphone sans provenance documentée (issue #26)', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin');
    try {
      const nom = `Test Officiel ${Date.now()}`;
      createdNoms.push(nom);
      const response = await POST(officielsRequest('POST', token, { nom, telephone: '0600000000' }));
      expect(response.status).toBe(400);
    } finally {
      await cleanup();
    }
  });

  it('masque un arbitre club désactivé du référentiel de sélection (issue #206)', async () => {
    const { token, cleanup } = await createTestUserAndSession('admin');
    const inactive = await createTestUserAndSession('dirigeant', { active: false }, ['arbitre_club']);
    try {
      const listResponse = await GET(officielsRequest('GET', token));
      const list = await listResponse.json();
      expect(list.officiels.some((o: { nom: string }) => o.nom === inactive.user.nom)).toBe(false);
    } finally {
      await cleanup();
      await inactive.cleanup();
    }
  });
});
