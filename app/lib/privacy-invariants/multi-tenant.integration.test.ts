/**
 * Suite « privacy invariants » (issue #41) — isolation multi-tenant, table-driven.
 *
 * Pour chaque route qui accepte un identifiant d'objet en paramètre, on crée
 * l'objet sous un club A avec des données strictement sentinelles, puis on
 * l'interroge avec la session d'un administrateur du club B : la frontière doit
 * refuser l'accès (403/404 selon la route, jamais 200 avec les données d'autrui)
 * et le corps de réponse ne doit jamais contenir la donnée sentinelle du club A.
 *
 * Cette matrice ne réimplémente aucune logique métier : chaque cas appelle le
 * vrai handler de route (comme les autres `*.integration.test.ts` du dépôt) sur
 * une base MariaDB réelle (`describe.skipIf(!isDbAvailable())`).
 *
 * Elle couvre un échantillon représentatif d'une famille par domaine (chat,
 * fiches sans compte, planning/matches, comptes utilisateurs) plutôt que les 22
 * routes du dépôt portant un identifiant d'objet : les routes à jeton opaque
 * (iCal, invitations, exports…) suivent un modèle de menace différent (jeton
 * imprévisible à usage unique) et sont déjà couvertes par leurs propres suites
 * (`boundaries.test.ts`, `privacy.integration.test.ts`, offboarding). Étendre
 * cette table à d'autres routes à identifiant interne est un gain incrémental
 * direct : ajouter une entrée à `cases`.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getDb } from '@/lib/db';
import { isDbAvailable } from '@/lib/db/test-utils';
import { createTestUserAndSession } from '@/lib/auth/test-helpers';
import { createChannel } from '@/lib/chat/service';
import { getSessionUser } from '@/lib/auth/session';
import { GET as getChatAttachment } from '@/app/api/chat/attachments/[id]/route';
import { PATCH as patchChannel } from '@/app/api/chat/channels/[id]/route';
import { POST as postOfficiel } from '@/app/api/officiels/route';
import { PATCH as patchNonAccountContact } from '@/app/api/non-account-contacts/[id]/route';
import { GET as getMatchExtras } from '@/app/api/matches/[id]/route';
import { PUT as putUser } from '@/app/api/users/[id]/route';
import { forbiddenSentinelBundle, sentinelClubId } from './sentinel-factory';
import { findRealisticPii } from './pii-heuristics';

const dbAvailable = await isDbAvailable();

function req(url: string, token: string | undefined, body?: unknown, method = 'GET') {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      ...(token ? { cookie: `session_token=${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

interface TenantCase {
  name: string;
  setup: (clubA: string) => Promise<{ objectId: string; needle: string }>;
  invoke: (objectId: string, tokenB: string) => Promise<Response>;
  /** Statuts acceptables pour un refus d'accès cross-tenant (jamais 200 avec la donnée d'autrui). */
  deniedStatuses: number[];
}

describe.skipIf(!dbAvailable)('frontière: isolation multi-tenant — matrice table-driven (issue #41)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      await cleanup();
    }
  });

  const cases: TenantCase[] = [
    {
      name: 'GET /api/chat/attachments/[id] — pièce jointe d\'un autre club',
      async setup(clubA) {
        const db = await getDb();
        const admin = await createTestUserAndSession('admin', { clubId: clubA });
        cleanups.push(admin.cleanup);
        const bundle = forbiddenSentinelBundle('chat-attachment-tenant');
        const roomId = `room-${randomBytes(8).toString('hex')}`;
        const attachmentId = `att-${randomBytes(8).toString('hex')}`;
        await db.query(
          `INSERT INTO chat_rooms (id, type, clubId, roomKey, name, createdByUserId)
           VALUES (?, 'direct', ?, ?, NULL, ?)`,
          [roomId, clubA, `key-${roomId}`, admin.user.id],
        );
        await db.query(
          `INSERT INTO chat_attachments (id, club_id, room_id, kind, file_name, mime_type, size_bytes, content, uploaded_by_user_id)
           VALUES (?, ?, ?, 'document', 'sentinel.txt', 'text/plain', ?, ?, ?)`,
          [attachmentId, clubA, roomId, Buffer.byteLength(bundle.freeText), Buffer.from(bundle.freeText), admin.user.id],
        );
        cleanups.push(async () => {
          await db.query('DELETE FROM chat_attachments WHERE id = ?', [attachmentId]);
          await db.query('DELETE FROM chat_rooms WHERE id = ?', [roomId]);
        });
        return { objectId: attachmentId, needle: bundle.freeText };
      },
      invoke: (objectId, tokenB) => getChatAttachment(
        req(`/api/chat/attachments/${objectId}`, tokenB),
        { params: { id: objectId } },
      ),
      deniedStatuses: [403, 404],
    },
    {
      name: 'PATCH /api/chat/channels/[id] — canal appartenant à un autre club',
      async setup(clubA) {
        const admin = await createTestUserAndSession('admin', { clubId: clubA });
        cleanups.push(admin.cleanup);
        const bundle = forbiddenSentinelBundle('chat-channel-tenant');
        const db = await getDb();
        const adminSession = await getSessionUser(admin.token);
        const room = await createChannel(db, adminSession!, { name: bundle.freeText }, []);
        cleanups.push(async () => {
          await db.query('DELETE FROM chat_participants WHERE roomId = ?', [room.id]);
          await db.query('DELETE FROM chat_rooms WHERE id = ?', [room.id]);
        });
        return { objectId: room.id, needle: bundle.freeText };
      },
      invoke: (objectId, tokenB) => patchChannel(
        req(`/api/chat/channels/${objectId}`, tokenB, { name: 'Renomme depuis un autre club' }, 'PATCH'),
        { params: { id: objectId } },
      ),
      deniedStatuses: [403, 404],
    },
    {
      name: 'PATCH /api/non-account-contacts/[id] — fiche sans compte d\'un autre club',
      async setup(clubA) {
        const admin = await createTestUserAndSession('admin', { clubId: clubA });
        cleanups.push(admin.cleanup);
        const bundle = forbiddenSentinelBundle('non-account-contact-tenant');
        const created = await postOfficiel(req('/api/officiels', admin.token, {
          nom: bundle.name,
          provenance: 'responsable_club',
        }, 'POST'));
        expect(created.status).toBe(200);
        const body = await created.json() as { data: { officiels: Array<{ id: number; nom: string }> } };
        const profile = body.data.officiels.find((item) => item.nom === bundle.name);
        if (!profile) throw new Error('fiche sentinelle non créée');
        return { objectId: String(profile.id), needle: bundle.name };
      },
      invoke: (objectId, tokenB) => patchNonAccountContact(
        req(`/api/non-account-contacts/${objectId}`, tokenB, { opposition: true }, 'PATCH'),
        { params: { id: objectId } },
      ),
      deniedStatuses: [403, 404],
    },
    {
      name: 'GET /api/matches/[id] — extras de match d\'un autre club',
      async setup(clubA) {
        const db = await getDb();
        const bundle = forbiddenSentinelBundle('match-extras-tenant');
        const matchId = `match-${randomBytes(8).toString('hex')}`;
        await db.getRepository('MatchExtra').save({
          clubId: clubA,
          matchId,
          payload: { note: bundle.freeText },
        });
        cleanups.push(async () => {
          await db.query('DELETE FROM matches_extras WHERE clubId = ? AND matchId = ?', [clubA, matchId]);
        });
        return { objectId: matchId, needle: bundle.freeText };
      },
      invoke: (objectId, tokenB) => getMatchExtras(
        req(`/api/matches/${objectId}`, tokenB),
        { params: { id: objectId } },
      ),
      // La route renvoie 200/`null` (pas de fuite d'existence côté club) plutôt qu'un
      // 403/404 explicite : l'assertion de contenu ci-dessous couvre ce cas.
      deniedStatuses: [200, 404],
    },
    {
      name: 'PUT /api/users/[id] — profil d\'un autre club',
      async setup(clubA) {
        const bundle = forbiddenSentinelBundle('users-tenant');
        const target = await createTestUserAndSession('dirigeant', { clubId: clubA, nom: bundle.name });
        cleanups.push(target.cleanup);
        return { objectId: String(target.user.id), needle: bundle.name };
      },
      invoke: (objectId, tokenB) => putUser(
        req(`/api/users/${objectId}`, tokenB, { nom: 'Renomme depuis un autre club' }, 'PUT'),
        { params: { id: objectId } },
      ),
      deniedStatuses: [403, 404],
    },
  ];

  it.each(cases)('$name', async ({ setup, invoke, deniedStatuses }) => {
    const clubA = sentinelClubId('tenant-a');
    const clubB = sentinelClubId('tenant-b');
    const { objectId, needle } = await setup(clubA);
    const adminB = await createTestUserAndSession('admin', { clubId: clubB });
    cleanups.push(adminB.cleanup);

    const response = await invoke(objectId, adminB.token);
    expect(deniedStatuses, `statut inattendu ${response.status}`).toContain(response.status);

    const text = await response.clone().text();
    expect(text.toLowerCase()).not.toContain(needle.toLowerCase());
    expect(findRealisticPii(text)).toEqual([]);
  });
});
