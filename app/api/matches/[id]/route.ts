import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { logAuditEntry } from '@/lib/db/audit-log';
import type { MatchExtras } from '@/hooks/useMatchExtras';
import type { MatchAmicalEntity, MatchOfficialEntity } from '@/lib/db/schemas';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { propagateAssignmentChangesIfPublished } from '@/lib/planning/assignment-propagation';
import {
  getPlanningEventSnapshot,
  PlanningConcurrencyError,
  saveMatchExtrasOptimistically,
  validateMatchExtrasAssignments,
} from '@/lib/planning/event-store';
import { PlanningValidationError } from '@/lib/planning/validation';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { parseMatchExtrasPayload } from '@/lib/db/planning-payload-codecs';
import { MATCH_EXTRAS_CLIENT_WRITE_FIELDS } from '@/lib/planning/match-extras-write-payload';
import { BodyValidator, parseJsonBody, RequestValidationError } from '@/lib/validation/request';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const matchId = resolvedParams.id;
    if (!matchId || matchId === 'undefined' || matchId.trim() === '') {
      return NextResponse.json({ error: 'ID de match invalide' }, { status: 400 });
    }

    const db = await getDb();
    const row = await db.getRepository('MatchExtra').findOneBy({ matchId, clubId: auth.user.clubId });
    return NextResponse.json(row ? parseMatchExtrasPayload(row.payload, matchId) : null);
  } catch (error) {
    logError('app.unhandled', 'Erreur GET match extras:', error);
    return NextResponse.json({ error: 'Erreur lors de la récupération des informations' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } }
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const matchId = resolvedParams.id;
    if (!matchId || matchId === 'undefined' || matchId.trim() === '') {
      return NextResponse.json({ error: 'ID de match invalide' }, { status: 400 });
    }

    const body = parseJsonBody(await request.json());
    const v = new BodyValidator(body);
    v.forbidUnknownFields([...MATCH_EXTRAS_CLIENT_WRITE_FIELDS]);
    const confirmedValue = v.boolean('confirmed', { required: false });
    const arbitreToucheInput = v.assignmentContacts('arbitreTouche', { required: false });
    const contactEncadrantsInput = v.assignmentContacts('contactEncadrants', { required: false });
    const contactAccompagnateurInput = v.assignmentContacts('contactAccompagnateur', { required: false });
    v.throwIfInvalid();

    const db = await getDb();
    const repo = db.getRepository('MatchExtra');
    const existing = await repo.findOneBy({ matchId, clubId: auth.user.clubId });
    const previous: MatchExtras = existing
      ? parseMatchExtrasPayload(existing.payload, matchId)
      : { id: matchId };

    const extras: MatchExtras = {
      ...previous,
      id: matchId,
      confirmed: confirmedValue === true || confirmedValue === false ? confirmedValue : previous.confirmed,
      arbitreTouche: await enrichAssignmentContacts(
        db,
        auth.user.clubId,
        arbitreToucheInput ?? previous.arbitreTouche,
        'officiel',
        previous.arbitreTouche,
      ),
      contactEncadrants: await enrichAssignmentContacts(
        db,
        auth.user.clubId,
        contactEncadrantsInput ?? previous.contactEncadrants,
        'encadrant',
        previous.contactEncadrants,
      ),
      contactAccompagnateur: await enrichAssignmentContacts(
        db,
        auth.user.clubId,
        contactAccompagnateurInput ?? previous.contactAccompagnateur,
        'accompagnateur',
        previous.contactAccompagnateur,
      ),
    };

    const official = await db.getRepository<MatchOfficialEntity>('MatchOfficial').findOneBy({ id: matchId, clubId: auth.user.clubId });
    const friendly = official ? null : await db.getRepository<MatchAmicalEntity>('MatchAmical').findOneBy({ id: matchId, clubId: auth.user.clubId });
    const eventType = official ? 'officiel' : 'amical';
    const snapshot = official || friendly ? await getPlanningEventSnapshot(db, eventType, matchId) : null;
    if (snapshot) {
      await validateMatchExtrasAssignments(db, snapshot, extras);
    }
    const before = existing ? (existing.payload as unknown as Record<string, unknown>) : null;
    const savedExtras = await saveMatchExtrasOptimistically(db, matchId, extras, snapshot?.revision ?? 0);

    // Un changement d'affectation sur un match déjà publié reste en préparation : il
    // marque l'événement `modified` et n'est visible/notifié qu'à la prochaine
    // publication globale, au même titre qu'un changement de date ou de lieu (issue #197).
    if (snapshot) {
      const propagationContext = {
        ...snapshot,
        extras: savedExtras as unknown as MatchExtras,
        assignments: {
          arbitre: savedExtras.arbitreTouche ?? [],
          encadrant: savedExtras.contactEncadrants ?? [],
          accompagnateur: savedExtras.contactAccompagnateur ?? [],
        },
      };
      await propagateAssignmentChangesIfPublished(
        db, auth.user.clubId, propagationContext,
        previous.arbitreTouche, savedExtras.arbitreTouche,
      );
      await propagateAssignmentChangesIfPublished(
        db, auth.user.clubId, propagationContext,
        previous.contactEncadrants, savedExtras.contactEncadrants,
      );
      await propagateAssignmentChangesIfPublished(
        db, auth.user.clubId, propagationContext,
        previous.contactAccompagnateur, savedExtras.contactAccompagnateur,
      );
    }

    try {
      await logAuditEntry(db, {
        user: auth.user,
        entityType: 'MatchExtra',
        entityId: matchId,
        action: before ? 'update' : 'create',
        before,
        after: extras as unknown as Record<string, unknown>,
      });
    } catch (auditError) {
      logError('app.unhandled', 'Erreur audit log match extras:', auditError);
    }

    return NextResponse.json({ success: true, extras: savedExtras });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: error.message, issues: error.issues }, { status: 400 });
    }
    if (error instanceof PlanningValidationError) {
      return NextResponse.json({ error: error.message, blockers: error.details }, { status: 409 });
    }
    if (error instanceof PlanningConcurrencyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logError('app.unhandled', 'Erreur PUT match extras:', error);
    return NextResponse.json({ error: 'Erreur lors de la modification des informations' }, { status: 500 });
  }
}
