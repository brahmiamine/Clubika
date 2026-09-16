import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import { serializeMatchExtrasPayload, serializeMatchPayload } from '@/lib/db/planning-payload-codecs';
import { parseOfficialMatchesCsv } from '@/lib/planning/official-csv';
import { BodyValidator, parseJsonBody, RequestValidationError } from '@/lib/validation/request';
import { logError } from '@/lib/observability/log';

const MAX_CSV_CHARS = 256_000;
const MAX_CSV_ROWS = 200;

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = parseJsonBody(await request.json());
    const v = new BodyValidator(body);
    v.string('csvText', { maxLength: MAX_CSV_CHARS });
    v.boolean('rightsAttested', { required: true });
    v.throwIfInvalid();

    if (body.rightsAttested !== true) {
      return NextResponse.json(
        { error: 'Vous devez attester que le club est autorisé à utiliser ces informations.' },
        { status: 400 },
      );
    }

    const parsed = parseOfficialMatchesCsv(String(body.csvText), auth.user.id);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    if (parsed.matches.length > MAX_CSV_ROWS) {
      return NextResponse.json(
        { error: `L’import est limité à ${MAX_CSV_ROWS} matchs par fichier.` },
        { status: 400 },
      );
    }

    const db = await getDb();
    const created: string[] = [];
    await db.transaction(async (manager) => {
      for (const match of parsed.matches) {
        const matchId = match.id as string;
        await manager.getRepository('MatchOfficial').save({
          id: matchId,
          clubId: auth.user.clubId,
          date: match.date,
          time: match.time || '',
          sourceMatchId: match.sourceMatchId ?? null,
          payload: serializeMatchPayload(match),
        });
        await manager.getRepository('MatchExtra').save({
          matchId,
          clubId: auth.user.clubId,
          payload: serializeMatchExtrasPayload({ id: matchId, planningStatus: 'draft' }),
        });
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'MatchOfficial',
          entityId: matchId,
          action: 'create',
          before: null,
          after: { id: matchId, type: 'officiel', importProvenance: match.importProvenance },
        });
        created.push(matchId);
      }
    });

    return NextResponse.json({ success: true, createdCount: created.length, ids: created });
  } catch (error) {
    if (error instanceof RequestValidationError) {
      return NextResponse.json({ error: 'Requête invalide', details: error.issues }, { status: 400 });
    }
    logError('app.unhandled', 'Official CSV import failed:', error);
    return NextResponse.json({ error: 'Impossible d’importer le calendrier officiel' }, { status: 500 });
  }
}
