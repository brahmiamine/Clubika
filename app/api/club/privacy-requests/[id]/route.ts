import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { UserEntity } from '@/lib/db/schemas';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/privacy/catalog';
import { getPrivacyRequest, patchPrivacyRequest, toPrivacyRequestDto } from '@/lib/privacy/requests';
import { applyProcessingFlag } from '@/lib/privacy/rectify';
import { issueExportToken } from '@/lib/privacy/download';
import { normalizePrivacyEmail } from '@/lib/privacy/catalog';
import { logError } from '@/lib/observability/log';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const id = (params instanceof Promise ? await params : params).id;
  const db = await getDb();
  const row = await getPrivacyRequest(db, auth.user.clubId, id);
  if (!row) return NextResponse.json({ error: 'Demande introuvable' }, { status: 404 });
  return NextResponse.json({ legalNotice: PRIVACY_NO_LEGAL_PROMISE, request: toPrivacyRequestDto(row) });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  try {
    const id = (params instanceof Promise ? await params : params).id;
    const db = await getDb();
    const row = await getPrivacyRequest(db, auth.user.clubId, id);
    if (!row) return NextResponse.json({ error: 'Demande introuvable' }, { status: 404 });
    const body = await request.json();

    const dueAt = body.dueAt === null
      ? null
      : typeof body.dueAt === 'string' && !Number.isNaN(Date.parse(body.dueAt))
        ? new Date(body.dueAt)
        : undefined;

    try {
      await patchPrivacyRequest(db, row, {
        status: body.status,
        decisionCode: body.decisionCode,
        responseProof: body.responseProof,
        assigneeUserId: body.assigneeUserId === null ? null : Number.isInteger(Number(body.assigneeUserId)) ? Number(body.assigneeUserId) : undefined,
        dueAt,
        claimedEmail: typeof body.claimedEmail === 'string' ? normalizePrivacyEmail(body.claimedEmail) : null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Mise à jour impossible';
      const mismatch = message.includes('concordante');
      return NextResponse.json({ error: message }, { status: mismatch ? 409 : 400 });
    }

    if (body.applyRestriction === true || body.applyOpposition === true) {
      const subjectId = row.subjectUserId;
      if (!subjectId) {
        return NextResponse.json({ error: 'Identité non liée : impossible d’appliquer la restriction' }, { status: 409 });
      }
      const user = await db.getRepository<UserEntity>('User').findOneBy({ id: subjectId, clubId: auth.user.clubId });
      if (!user) return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
      await applyProcessingFlag(db, user, body.applyOpposition === true ? 'opposition' : 'restriction');
      row.status = 'completed';
      row.decisionCode = 'granted';
      row.responseProof = body.applyOpposition === true ? 'opposition-flag' : 'restriction-flag';
      row.completedAt = new Date();
      await db.getRepository('PrivacyRequest').save(row);
    }

    if (body.issueExport === true) {
      const subjectId = row.subjectUserId;
      if (!subjectId) {
        return NextResponse.json({ error: 'Identité non liée : impossible d’émettre un export' }, { status: 409 });
      }
      const user = await db.getRepository<UserEntity>('User').findOneBy({ id: subjectId, clubId: auth.user.clubId });
      if (!user) return NextResponse.json({ error: 'Compte introuvable' }, { status: 404 });
      const issued = await issueExportToken(db, user, row.id);
      row.status = 'completed';
      row.decisionCode = 'granted';
      row.responseProof = 'export-token';
      row.completedAt = new Date();
      await db.getRepository('PrivacyRequest').save(row);
      return NextResponse.json({
        legalNotice: PRIVACY_NO_LEGAL_PROMISE,
        request: toPrivacyRequestDto(row),
        export: { expiresAt: issued.expiresAt, downloadPath: issued.downloadPath, token: issued.token },
      });
    }

    const refreshed = await getPrivacyRequest(db, auth.user.clubId, id);
    return NextResponse.json({
      legalNotice: PRIVACY_NO_LEGAL_PROMISE,
      request: toPrivacyRequestDto(refreshed!),
    });
  } catch (error) {
    logError('app.unhandled', 'Privacy request patch failed:', error);
    return NextResponse.json({ error: 'Impossible de mettre à jour la demande' }, { status: 500 });
  }
}
