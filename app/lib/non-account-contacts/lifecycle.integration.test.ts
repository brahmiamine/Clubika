import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { hashContactLookup } from '@/lib/non-account-contacts/format';
import { POST as postOfficiel } from '@/app/api/officiels/route';
import { GET as getUsers } from '@/app/api/users/route';
import { POST as postInvitation } from '@/app/api/invitations/route';
import { POST as postImport } from '@/app/api/non-account-contacts/import/route';
import { GET as getContacts } from '@/app/api/non-account-contacts/route';
import { PATCH as patchFiche } from '@/app/api/non-account-contacts/[id]/route';
import { POST as postPublicRights } from '@/app/api/public/non-account-rights/route';
import { PATCH as patchRights } from '@/app/api/non-account-rights/route';
import { DELETE as deleteOfficiel } from '@/app/api/officiels/route';
import type { NonAccountContactMetaEntity, NonAccountRightsRequestEntity, UserEntity } from '@/lib/db/schemas';

const dbAvailable = await isDbAvailable();

function jsonRequest(url: string, method: string, token: string | undefined, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: {
      ...(token ? { cookie: `session_token=${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe.skipIf(!dbAvailable)('fiches sans compte (issue #26)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  async function trackClub(clubId: string) {
    cleanups.push(async () => {
      const db = await getDb();
      await db.query('DELETE FROM non_account_rights_requests WHERE clubId = ?', [clubId]);
      await db.query('DELETE FROM club_notice_config WHERE clubId = ?', [clubId]);
      const users = await db.getRepository<UserEntity>('User').find({ where: { clubId } });
      const ids = users.map((user) => user.id);
      if (ids.length > 0) {
        await db.getRepository('NonAccountContactMeta').createQueryBuilder().delete()
          .where('userId IN (:...ids)', { ids }).execute();
        await db.getRepository('Invitation').createQueryBuilder().delete().where('clubId = :clubId', { clubId }).execute();
        await db.getRepository('UserSession').createQueryBuilder().delete()
          .where('userId IN (:...ids)', { ids }).execute();
        await db.getRepository('User').createQueryBuilder().delete().where('id IN (:...ids)', { ids }).execute();
      }
    });
  }

  it('autorise une fiche nominative sans téléphone, refuse le téléphone sans provenance, masque le numéro', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    await trackClub(clubId);
    const admin = await createTestUserAndSession('admin', { clubId });
    const nom = `Fiche ${randomBytes(3).toString('hex')}`;

    const withoutPhone = await postOfficiel(jsonRequest('http://localhost/api/officiels', 'POST', admin.token, { nom }));
    expect(withoutPhone.status).toBe(200);

    const blocked = await postOfficiel(jsonRequest('http://localhost/api/officiels', 'POST', admin.token, {
      nom: `${nom} tel`,
      telephone: '0600000000',
    }));
    expect(blocked.status).toBe(400);

    const withPhone = await postOfficiel(jsonRequest('http://localhost/api/officiels', 'POST', admin.token, {
      nom: `${nom} tel`,
      telephone: '0600000099',
      provenance: 'responsable_club',
      purpose: 'organisation_planning',
    }));
    expect(withPhone.status).toBe(200);

    const list = await getUsers(jsonRequest('http://localhost/api/users?sansAcces=1', 'GET', admin.token));
    const body = await list.json() as { users: Array<{ nom: string; telephone: string | null; telephoneMasked?: boolean }> };
    const masked = body.users.find((user) => user.nom === `${nom} tel`);
    expect(masked?.telephoneMasked).toBe(true);
    expect(masked?.telephone).toBe('•• •• •• •• 99');
    expect(JSON.stringify(body)).not.toContain('0600000099');
  });

  it('laisse la notice en pending tant qu’aucune version n’est configurée, puis enregistre une preuve d’invitation', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    await trackClub(clubId);
    const admin = await createTestUserAndSession('admin', { clubId });
    const nom = `Notice ${randomBytes(3).toString('hex')}`;

    const created = await postOfficiel(jsonRequest('http://localhost/api/officiels', 'POST', admin.token, {
      nom,
      provenance: 'responsable_club',
    }));
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { data: { officiels: Array<{ id: number; nom: string }> } };
    const profile = createdBody.data.officiels.find((item) => item.nom === nom);
    expect(profile?.id).toBeDefined();

    const invited = await postInvitation(jsonRequest('http://localhost/api/invitations', 'POST', admin.token, {
      accessRole: 'dirigeant',
      personId: profile!.id,
      adultConfirmed: true,
    }));
    expect(invited.status).toBe(200);

    const db = await getDb();
    const meta = await db.getRepository<NonAccountContactMetaEntity>('NonAccountContactMeta').findOneBy({ userId: profile!.id });
    expect(meta?.noticeResult).toBe('pending');
    expect(meta?.noticeChannel).toBe('invitation');
    expect(meta?.noticeVersion).toBeNull();
  });

  it('isole deux clubs : opposition et import CSV sans recopier de PII', async () => {
    const clubA = `test-club-a-${randomBytes(6).toString('hex')}`;
    const clubB = `test-club-b-${randomBytes(6).toString('hex')}`;
    await trackClub(clubA);
    await trackClub(clubB);
    const adminA = await createTestUserAndSession('admin', { clubId: clubA });
    const adminB = await createTestUserAndSession('admin', { clubId: clubB });
    const nom = `Contact ${randomBytes(3).toString('hex')}`;

    const createA = await postOfficiel(jsonRequest('http://localhost/api/officiels', 'POST', adminA.token, {
      nom,
      telephone: '0611111199',
      provenance: 'responsable_club',
    }));
    expect(createA.status).toBe(200);
    const createB = await postOfficiel(jsonRequest('http://localhost/api/officiels', 'POST', adminB.token, {
      nom,
      telephone: '0611111199',
      provenance: 'liste_competition',
    }));
    expect(createB.status).toBe(200);

    const csv = [
      'nom,provenance,category,telephone',
      'Personne Import,responsable_club,officiel,0622222299',
      'Sans Source,,officiel,0633333399',
    ].join('\n');
    const imported = await postImport(jsonRequest('http://localhost/api/non-account-contacts/import', 'POST', adminA.token, { csv }));
    expect(imported.status).toBe(200);
    const report = await imported.json() as { accepted: number; refused: Array<{ line: number; error: string }> };
    expect(report.accepted).toBe(1);
    expect(report.refused).toEqual([{ line: 3, error: 'provenance_absente' }]);
    expect(JSON.stringify(report)).not.toContain('Personne Import');
    expect(JSON.stringify(report)).not.toContain('0622222299');
    expect(JSON.stringify(report)).not.toContain('0633333399');

    // Issue #18 : aucun import automatisé ne doit produire de compte utilisable —
    // seule une invitation explicitement confirmée « majeure » par un administrateur
    // peut activer un profil. Le profil importé reste un référentiel sans accès :
    // `claimedAt` à `null`, mot de passe inconnu de quiconque.
    const importedDb = await getDb();
    const importedProfile = await importedDb.getRepository<UserEntity>('User').findOneBy({ clubId: clubA, nom: 'Personne Import' });
    expect(importedProfile).not.toBeNull();
    expect(importedProfile?.claimedAt).toBeNull();
    expect(importedProfile?.passwordHash).not.toBe('');

    const listB = await getContacts(jsonRequest('http://localhost/api/non-account-contacts', 'GET', adminB.token));
    const bodyB = await listB.json() as { fiches: Array<{ nom: string }> };
    expect(bodyB.fiches.some((fiche) => fiche.nom === 'Personne Import')).toBe(false);
    expect(bodyB.fiches.some((fiche) => fiche.nom === nom)).toBe(true);

    const createdABody = await createA.json() as { data: { officiels: Array<{ id: number; nom: string }> } };
    const ficheA = createdABody.data.officiels.find((item) => item.nom === nom)!;
    const opposed = await patchFiche(
      jsonRequest(`http://localhost/api/non-account-contacts/${ficheA.id}`, 'PATCH', adminA.token, { opposition: true }),
      { params: { id: String(ficheA.id) } },
    );
    expect(opposed.status).toBe(200);

    const db = await getDb();
    const userA = await db.getRepository<UserEntity>('User').findOneBy({ id: ficheA.id });
    expect(userA?.telephone).toBeNull();
    const userB = (await db.getRepository<UserEntity>('User').find({ where: { clubId: clubB, nom } }))[0];
    expect(userB?.telephone).toBe('0611111199');

    const deleted = await deleteOfficiel(jsonRequest(
      `http://localhost/api/officiels?nom=${encodeURIComponent(nom)}`,
      'DELETE',
      adminA.token,
    ));
    expect(deleted.status).toBe(200);
    expect(await db.getRepository<UserEntity>('User').findOneBy({ id: ficheA.id })).toBeNull();
  });

  it('stocke uniquement des empreintes pour une demande publique et applique l’opposition', async () => {
    const clubId = `test-club-${randomBytes(6).toString('hex')}`;
    await trackClub(clubId);
    setCurrentClubId(clubId);
    const admin = await createTestUserAndSession('admin', { clubId });
    const nom = `Public ${randomBytes(3).toString('hex')}`;
    const phone = '0644444499';

    const created = await postOfficiel(jsonRequest('http://localhost/api/officiels', 'POST', admin.token, {
      nom,
      telephone: phone,
      provenance: 'declaration_concernee',
    }));
    expect(created.status).toBe(200);

    const email = `personne-${randomBytes(3).toString('hex')}@example.com`;
    const publicRes = await postPublicRights(jsonRequest('http://localhost/api/public/non-account-rights', 'POST', undefined, {
      clubId,
      type: 'opposition',
      email,
      telephone: phone,
    }));
    expect(publicRes.status).toBe(202);
    const publicBody = await publicRes.json() as Record<string, unknown>;
    expect(JSON.stringify(publicBody)).not.toContain(email);
    expect(JSON.stringify(publicBody)).not.toContain(phone);

    const db = await getDb();
    const rows = await db.getRepository<NonAccountRightsRequestEntity>('NonAccountRightsRequest').find({ where: { clubId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subjectEmailHash).toBe(hashContactLookup(clubId, email));
    expect(rows[0]?.subjectPhoneHash).toBe(hashContactLookup(clubId, phone));
    expect(rows[0]?.subjectEmailHash).not.toBe(email);
    expect(JSON.stringify(rows[0])).not.toContain(email);
    expect(JSON.stringify(rows[0])).not.toContain(phone);

    const duplicate = await postPublicRights(jsonRequest('http://localhost/api/public/non-account-rights', 'POST', undefined, {
      clubId,
      type: 'opposition',
      telephone: phone,
    }));
    expect(duplicate.status).toBe(429);

    const processed = await patchRights(jsonRequest('http://localhost/api/non-account-rights', 'PATCH', admin.token, {
      id: rows[0]!.id,
      action: 'opposition',
    }));
    expect(processed.status).toBe(200);
    const user = (await db.getRepository<UserEntity>('User').find({ where: { clubId, nom } }))[0];
    expect(user?.telephone).toBeNull();
  });
});
