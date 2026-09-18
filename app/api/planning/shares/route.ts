import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import { getDb } from '@/lib/db';
import { logAuditEntry } from '@/lib/db/audit-log';
import {
  deletePlanningRecord,
  listPlanningRecords,
  planningRecordId,
  savePlanningRecord,
} from '@/lib/planning/records';
import {
  clampShareExpiryDays,
  hashShareToken,
  newShareToken,
  publicShareMaxExpiryDays,
  type PublicShareScope,
} from '@/lib/planning/public-share';
import type { PlanningEventType } from '@/lib/planning/event-store';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';

interface PublicSharePayload {
  tokenHash: string;
  expiresAt: string;
  scope: PublicShareScope;
  createdByUserId: number;
}

const EVENT_TYPES: PlanningEventType[] = ['officiel', 'amical', 'entrainement', 'plateau'];

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeEventTypes(value: unknown): PlanningEventType[] {
  if (!Array.isArray(value)) return [...EVENT_TYPES];
  const filtered = value.filter((item): item is PlanningEventType => EVENT_TYPES.includes(item as PlanningEventType));
  return filtered.length ? [...new Set(filtered)] : [...EVENT_TYPES];
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'publicSharing');
  if (disabled) return disabled;
  const records = await listPlanningRecords<PublicSharePayload>(db, { kind: 'public-share' }, 250);
  return NextResponse.json({
    shares: records.map((record) => ({
      id: record.id,
      expiresAt: record.payload.expiresAt,
      scope: record.payload.scope,
      createdAt: record.createdAt,
      expired: Date.parse(record.payload.expiresAt) <= Date.now(),
    })),
    // Durée maximale proposée pour un nouveau lien (issue #14) : exposée ici pour que
    // l'administration l'affiche avant création plutôt que de la dupliquer côté client.
    maxExpiryDays: publicShareMaxExpiryDays(),
  });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    // Fenêtre plafonnée à 30 j par défaut (configurable), au lieu de 90 j (issue #14) :
    // couvre 0, une valeur négative, non numérique, 30 et plus de 30 jours.
    const maxExpiryDays = publicShareMaxExpiryDays();
    const expiryDays = clampShareExpiryDays(body.expiryDays, maxExpiryDays);
    const fromDate = validDate(body.fromDate) ? body.fromDate : null;
    const toDate = validDate(body.toDate) ? body.toDate : null;
    if (fromDate && toDate && fromDate > toDate) {
      return NextResponse.json({ error: 'Période de partage invalide' }, { status: 400 });
    }

    const scope: PublicShareScope = {
      eventTypes: normalizeEventTypes(body.eventTypes),
      fromDate,
      toDate,
    };
    const token = newShareToken();
    const id = planningRecordId('public-share');
    const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60_000).toISOString();
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'publicSharing');
    if (disabled) return disabled;
    const tokenHash = hashShareToken(token);
    await savePlanningRecord<PublicSharePayload>(db, {
      id,
      kind: 'public-share',
      ownerUserId: auth.user.id,
      // Colonne indexée dédiée (issue #277), en plus de la copie dans `payload` : une
      // résolution par jeton en lecture publique n'a ainsi jamais besoin de balayer les
      // enregistrements récents ni de connaître le club à l'avance.
      tokenHash,
      payload: {
        tokenHash,
        expiresAt,
        scope,
        createdByUserId: auth.user.id,
      },
    });
    await logAuditEntry(db, {
      user: auth.user,
      entityType: 'PlanningShare',
      entityId: id,
      action: 'share',
      before: null,
      after: { expiresAt, scope },
    });

    return NextResponse.json({
      success: true,
      share: { id, token, expiresAt, scope, path: `/partage/${token}` },
      maxExpiryDays,
    });
  } catch (error) {
    logError('app.unhandled', 'Creating planning share failed:', error);
    return NextResponse.json({ error: 'Impossible de créer le partage' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  const id = new URL(request.url).searchParams.get('id')?.trim();
  if (!id?.startsWith('public-share:')) return NextResponse.json({ error: 'Partage invalide' }, { status: 400 });

  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'publicSharing');
  if (disabled) return disabled;
  const deleted = await deletePlanningRecord(db, id);
  if (!deleted) return NextResponse.json({ error: 'Partage introuvable' }, { status: 404 });
  await logAuditEntry(db, {
    user: auth.user,
    entityType: 'PlanningShare',
    entityId: id,
    action: 'delete',
    before: { existed: true },
    after: null,
  });
  return NextResponse.json({ success: true });
}
