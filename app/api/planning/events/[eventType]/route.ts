import { logError } from '@/lib/observability/log';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  parseEntrainementPayload,
  parseMatchExtrasPayload,
  parseMatchPayload,
  parsePlateauPayload,
  serializeEntrainementPayload,
  serializeMatchExtrasPayload,
  serializeMatchPayload,
  serializePlateauPayload,
} from '@/lib/db/planning-payload-codecs';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { BodyValidator, parseJsonBody, RequestValidationError } from '@/lib/validation/request';
import type { MatchExtras } from '@/hooks/useMatchExtras';
import type { Entrainement, Match, Plateau } from '@/types/match';

const VENUE_VALUES = ['domicile', 'extérieur'] as const;
type CreatableEventType = 'amical' | 'entrainement' | 'plateau';

function isCreatableEventType(value: string): value is CreatableEventType {
  return value === 'amical' || value === 'entrainement' || value === 'plateau';
}

async function resolveParams(params: Promise<{ eventType: string }> | { eventType: string }) {
  return params instanceof Promise ? await params : params;
}

function idempotentId(eventType: CreatableEventType, clubId: string, request: NextRequest): string | null {
  const key = request.headers.get('Idempotency-Key')?.trim();
  if (!key) return null;
  const digest = createHash('sha256').update(`${clubId}:${eventType}:${key}`).digest('hex').slice(0, 24);
  return `${eventType}-${digest}`;
}

function generatedId(eventType: CreatableEventType, date: string, time: string): string {
  return `${eventType}-${date.replace(/\//g, '-')}-${time.replace(':', '-')}-${Date.now()}`;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventType: string }> | { eventType: string } },
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const { eventType: rawEventType } = await resolveParams(params);
  if (rawEventType === 'officiel') {
    return NextResponse.json(
      { error: 'Les matchs officiels sont gérés par la source fédérale et ne peuvent pas être créés manuellement.' },
      { status: 405 },
    );
  }
  if (!isCreatableEventType(rawEventType)) {
    return NextResponse.json({ error: 'Type d’événement invalide' }, { status: 400 });
  }
  const eventType = rawEventType;

  try {
    const body = parseJsonBody(await request.json());
    const db = await getDb();

    if (eventType === 'amical') {
      const v = new BodyValidator(body);
      v.date('date');
      v.time('time');
      v.string('competition', { maxLength: 128 });
      v.string('categorie', { required: false, maxLength: 64 });
      v.string('localTeam', { maxLength: 128 });
      v.string('awayTeam', { maxLength: 128 });
      v.enum('venue', VENUE_VALUES);
      v.time('horaireRendezVous', { required: false });
      v.number('durationMinutes', { required: false, min: 1, max: 1440 });
      v.boolean('confirmed', { required: false });
      v.assignmentContacts('arbitreTouche');
      v.assignmentContacts('contactEncadrants');
      v.assignmentContacts('contactAccompagnateur');
      v.throwIfInvalid();

      const {
        confirmed,
        arbitreTouche,
        contactEncadrants,
        contactAccompagnateur,
        ...matchPayload
      } = body;
      const match = matchPayload as unknown as Match;
      const stableId = idempotentId(eventType, auth.user.clubId, request);
      const matchId = stableId ?? match.id ?? generatedId(eventType, match.date, match.time);
      match.id = matchId;
      match.type = 'amical';
      match.durationMinutes = match.durationMinutes ?? 90;

      if (stableId) {
        const existing = await db.getRepository('MatchAmical').findOneBy({ id: stableId, clubId: auth.user.clubId });
        if (existing) {
          const existingMatch = parseMatchPayload(existing.payload, 'MatchAmical', { id: stableId, type: 'amical' });
          const extraRow = await db.getRepository('MatchExtra').findOneBy({ matchId: stableId, clubId: auth.user.clubId });
          const extras = extraRow ? parseMatchExtrasPayload(extraRow.payload, stableId) : { id: stableId, planningStatus: 'draft' as const };
          return NextResponse.json({ success: true, match: existingMatch, extras, planningStatus: extras.planningStatus ?? 'draft', idempotentReplay: true });
        }
      }

      const extras: MatchExtras = {
        id: matchId,
        planningStatus: 'draft',
        confirmed: confirmed === true || confirmed === false ? confirmed : undefined,
        arbitreTouche: await enrichAssignmentContacts(db, auth.user.clubId, arbitreTouche, 'officiel'),
        contactEncadrants: await enrichAssignmentContacts(db, auth.user.clubId, contactEncadrants, 'encadrant'),
        contactAccompagnateur: await enrichAssignmentContacts(db, auth.user.clubId, contactAccompagnateur, 'accompagnateur'),
      };

      await db.transaction(async (manager) => {
        await manager.getRepository('MatchAmical').save({
          id: matchId,
          clubId: auth.user.clubId,
          date: match.date,
          time: match.time || '',
          payload: serializeMatchPayload(match),
        });
        await manager.getRepository('MatchExtra').save({
          matchId,
          clubId: auth.user.clubId,
          payload: serializeMatchExtrasPayload(extras),
        });
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'MatchAmical',
          entityId: matchId,
          action: 'create',
          before: null,
          after: { ...(match as unknown as Record<string, unknown>), ...extras, planningStatus: 'draft' },
        });
      });

      return NextResponse.json({ success: true, match, extras, planningStatus: 'draft' });
    }

    if (eventType === 'entrainement') {
      const v = new BodyValidator(body);
      v.date('date');
      v.time('time');
      v.string('lieu', { maxLength: 255 });
      v.string('categorie', { required: false, maxLength: 64 });
      v.number('durationMinutes', { required: false, min: 1, max: 1440 });
      v.assignmentContacts('encadrants');
      v.throwIfInvalid();

      const input = body as unknown as Omit<Entrainement, 'id'>;
      const stableId = idempotentId(eventType, auth.user.clubId, request);
      const id = stableId ?? generatedId(eventType, input.date, input.time);

      if (stableId) {
        const existing = await db.getRepository('Entrainement').findOneBy({ id, clubId: auth.user.clubId });
        if (existing) {
          return NextResponse.json({
            success: true,
            entrainement: parseEntrainementPayload(existing.payload, id),
            idempotentReplay: true,
          });
        }
      }

      const entrainement: Entrainement = {
        ...input,
        id,
        type: 'entrainement',
        durationMinutes: input.durationMinutes ?? 90,
        planningStatus: 'draft',
        encadrants: await enrichAssignmentContacts(db, auth.user.clubId, input.encadrants, 'encadrant'),
      };

      await db.transaction(async (manager) => {
        await manager.getRepository('Entrainement').save({
          id,
          clubId: auth.user.clubId,
          date: entrainement.date,
          time: entrainement.time,
          payload: serializeEntrainementPayload(entrainement),
        });
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'Entrainement',
          entityId: id,
          action: 'create',
          before: null,
          after: entrainement as unknown as Record<string, unknown>,
        });
      });

      return NextResponse.json({ success: true, entrainement });
    }

    const v = new BodyValidator(body);
    v.date('date');
    v.time('time');
    v.string('lieu', { maxLength: 255 });
    v.stringArray('categories', { maxItemLength: 100 });
    v.number('durationMinutes', { required: false, min: 1, max: 1440 });
    v.assignmentContacts('encadrants');
    v.throwIfInvalid();

    const input = body as unknown as Omit<Plateau, 'id'>;
    const stableId = idempotentId(eventType, auth.user.clubId, request);
    const id = stableId ?? generatedId(eventType, input.date, input.time);

    if (stableId) {
      const existing = await db.getRepository('Plateau').findOneBy({ id, clubId: auth.user.clubId });
      if (existing) {
        return NextResponse.json({
          success: true,
          plateau: parsePlateauPayload(existing.payload, id),
          idempotentReplay: true,
        });
      }
    }

    const plateau: Plateau = {
      ...input,
      id,
      type: 'plateau',
      durationMinutes: input.durationMinutes ?? 120,
      planningStatus: 'draft',
      encadrants: await enrichAssignmentContacts(db, auth.user.clubId, input.encadrants, 'encadrant'),
    };

    await db.transaction(async (manager) => {
      await manager.getRepository('Plateau').save({
        id,
        clubId: auth.user.clubId,
        date: plateau.date,
        time: plateau.time,
        payload: serializePlateauPayload(plateau),
      });
      await logAuditEntry(manager, {
        user: auth.user,
        entityType: 'Plateau',
        entityId: id,
        action: 'create',
        before: null,
        after: plateau as unknown as Record<string, unknown>,
      });
    });

    return NextResponse.json({ success: true, plateau });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: 'Requête invalide', details: error.issues }, { status: 400 });
    }
    logError('app.unhandled', 'Canonical planning event creation failed:', error);
    return NextResponse.json({ error: 'Impossible de créer cet événement' }, { status: 500 });
  }
}
