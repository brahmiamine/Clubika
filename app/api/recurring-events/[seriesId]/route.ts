import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import type { Entrainement, Plateau } from '@/types/match';
import type { EntrainementEntity, PlateauEntity } from '@/lib/db/schemas';
import { logAuditEntry } from '@/lib/db/audit-log';
import { isVisiblePublicationStatus, normalizePlanningStatus } from '@/lib/planning/p0-rules';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { PlanningConcurrencyError } from '@/lib/planning/event-store';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { getPublishedPlanning, eventKey } from '@/lib/planning/published-planning';
import {
  parseEntrainementPayload,
  parsePlateauPayload,
  serializeEntrainementPayload,
  serializePlateauPayload,
} from '@/lib/db/planning-payload-codecs';

async function resolveParams(params: Promise<{ seriesId: string }> | { seriesId: string }) {
  return params instanceof Promise ? params : Promise.resolve(params);
}

function revisionOf(payload: Entrainement | Plateau | Record<string, unknown>): number {
  const revision = payload.planningRevision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ seriesId: string }> | { seriesId: string } },
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const { seriesId } = await resolveParams(params);
    const body = await request.json();
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'recurringEvents');
    if (disabled) return disabled;
    let updated = 0;
    const trainingChanges: Array<{ row: EntrainementEntity; before: Entrainement; after: Entrainement }> = [];
    const plateauChanges: Array<{ row: PlateauEntity; before: Plateau; after: Plateau }> = [];

    const trainingRepo = db.getRepository<EntrainementEntity>('Entrainement');
    const trainingRows = await trainingRepo.findBy({ clubId: auth.user.clubId });
    for (const row of trainingRows) {
      const current = parseEntrainementPayload(row.payload, row.id);
      if (current.seriesId !== seriesId) continue;
      const currentStatus = normalizePlanningStatus(current.planningStatus);
      const next: Entrainement = {
        ...current,
        time: typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time) ? body.time : current.time,
        lieu: typeof body.lieu === 'string' && body.lieu.trim() ? body.lieu.trim() : current.lieu,
        durationMinutes: Number.isFinite(body.durationMinutes) ? Math.min(720, Math.max(15, Math.round(body.durationMinutes))) : current.durationMinutes,
        categorie: typeof body.categorie === 'string' ? body.categorie.trim() || undefined : current.categorie,
        planningStatus: isVisiblePublicationStatus(currentStatus) ? 'modified' : currentStatus,
        ...(isVisiblePublicationStatus(currentStatus) ? { modifiedAfterPublishAt: new Date().toISOString() } : {}),
      };
      row.time = next.time;
      row.payload = serializeEntrainementPayload(next);
      trainingChanges.push({ row, before: current, after: next });
      updated += 1;
    }

    const plateauRepo = db.getRepository<PlateauEntity>('Plateau');
    const plateauRows = await plateauRepo.findBy({ clubId: auth.user.clubId });
    for (const row of plateauRows) {
      const current = parsePlateauPayload(row.payload, row.id);
      if (current.seriesId !== seriesId) continue;
      const currentStatus = normalizePlanningStatus(current.planningStatus);
      const categories = Array.isArray(body.categories)
        ? body.categories.filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '').map((value: string) => value.trim())
        : current.categories;
      const next: Plateau = {
        ...current,
        time: typeof body.time === 'string' && /^\d{2}:\d{2}$/.test(body.time) ? body.time : current.time,
        lieu: typeof body.lieu === 'string' && body.lieu.trim() ? body.lieu.trim() : current.lieu,
        durationMinutes: Number.isFinite(body.durationMinutes) ? Math.min(720, Math.max(15, Math.round(body.durationMinutes))) : current.durationMinutes,
        categories,
        planningStatus: isVisiblePublicationStatus(currentStatus) ? 'modified' : currentStatus,
        ...(isVisiblePublicationStatus(currentStatus) ? { modifiedAfterPublishAt: new Date().toISOString() } : {}),
      };
      row.time = next.time;
      row.payload = serializePlateauPayload(next);
      plateauChanges.push({ row, before: current, after: next });
      updated += 1;
    }

    if (!updated) return NextResponse.json({ error: 'Série introuvable' }, { status: 404 });
    await db.transaction(async (manager) => {
      const trainingTx = manager.getRepository<EntrainementEntity>('Entrainement');
      for (const change of trainingChanges) {
        const locked = await trainingTx.findOne({ where: { id: change.row.id, clubId: auth.user.clubId }, lock: { mode: 'pessimistic_write' } });
        if (!locked || revisionOf(locked.payload) !== revisionOf(change.before)) throw new PlanningConcurrencyError();
        change.after.planningRevision = revisionOf(change.before) + 1;
        locked.time = change.after.time;
        locked.payload = serializeEntrainementPayload(change.after);
        await trainingTx.save(locked);
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'Entrainement',
          entityId: change.row.id,
          action: 'update',
          before: change.before as unknown as Record<string, unknown>,
          after: change.after as unknown as Record<string, unknown>,
        });
      }
      const plateauTx = manager.getRepository<PlateauEntity>('Plateau');
      for (const change of plateauChanges) {
        const locked = await plateauTx.findOne({ where: { id: change.row.id, clubId: auth.user.clubId }, lock: { mode: 'pessimistic_write' } });
        if (!locked || revisionOf(locked.payload) !== revisionOf(change.before)) throw new PlanningConcurrencyError();
        change.after.planningRevision = revisionOf(change.before) + 1;
        locked.time = change.after.time;
        locked.payload = serializePlateauPayload(change.after);
        await plateauTx.save(locked);
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: 'Plateau',
          entityId: change.row.id,
          action: 'update',
          before: change.before as unknown as Record<string, unknown>,
          after: change.after as unknown as Record<string, unknown>,
        });
      }
    });
    /*
     * Les changements restent uniquement dans le planning de travail. Le snapshot
     * utilisateur et les notifications sont produits par la publication globale,
     * qui déduplique déjà les changements et reconfirmations (issue #200).
     */
    return NextResponse.json({ success: true, updated });
  } catch (error) {
    if (error instanceof PlanningConcurrencyError) return NextResponse.json({ error: error.message }, { status: 409 });
    logError('app.unhandled', 'Error updating recurring series:', error);
    return NextResponse.json({ error: 'Impossible de modifier la série' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ seriesId: string }> | { seriesId: string } },
) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const { seriesId } = await resolveParams(params);
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'recurringEvents');
    if (disabled) return disabled;

    const [trainingRows, plateauRows, published] = await Promise.all([
      db.getRepository<EntrainementEntity>('Entrainement').findBy({ clubId: auth.user.clubId }),
      db.getRepository<PlateauEntity>('Plateau').findBy({ clubId: auth.user.clubId }),
      getPublishedPlanning(db, auth.user.clubId),
    ]);
    const trainings = trainingRows
      .map((row) => ({ row, event: parseEntrainementPayload(row.payload, row.id) }))
      .filter(({ event }) => event.seriesId === seriesId);
    const plateaux = plateauRows
      .map((row) => ({ row, event: parsePlateauPayload(row.payload, row.id) }))
      .filter(({ event }) => event.seriesId === seriesId);
    const removed = trainings.length + plateaux.length;
    if (!removed) return NextResponse.json({ error: 'Série introuvable' }, { status: 404 });

    const publishedKeys = new Set((published?.events ?? []).map(eventKey));
    const cancelledAt = new Date().toISOString();
    let pendingCancellations = 0;

    await db.transaction(async (manager) => {
      const prepare = async (
        eventType: 'entrainement' | 'plateau',
        item: { row: EntrainementEntity | PlateauEntity; event: Entrainement | Plateau },
      ) => {
        const repo = eventType === 'entrainement'
          ? manager.getRepository<EntrainementEntity>('Entrainement')
          : manager.getRepository<PlateauEntity>('Plateau');
        const locked = await repo.findOne({
          where: { id: item.row.id, clubId: auth.user.clubId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!locked || revisionOf(locked.payload) !== revisionOf(item.event)) {
          throw new PlanningConcurrencyError();
        }

        const isPublished = publishedKeys.has(`${eventType}:${item.row.id}`);
        if (isPublished) {
          const cancelled = {
            ...item.event,
            planningStatus: 'cancelled' as const,
            cancelledAt,
            cancelledByUserId: auth.user.id,
            cancellationReason: 'Suppression de la série',
            planningRevision: revisionOf(item.event) + 1,
          };
          locked.payload = eventType === 'entrainement'
            ? serializeEntrainementPayload(cancelled as Entrainement)
            : serializePlateauPayload(cancelled as Plateau);
          await repo.save(locked as never);
          pendingCancellations += 1;
          await logAuditEntry(manager, {
            user: auth.user,
            entityType: eventType === 'entrainement' ? 'Entrainement' : 'Plateau',
            entityId: item.row.id,
            action: 'update',
            before: item.event as unknown as Record<string, unknown>,
            after: cancelled as unknown as Record<string, unknown>,
          });
          return;
        }

        await repo.remove(locked as never);
        await manager.query(
          `INSERT INTO planning_event_state (club_id, event_type, event_id, archived_at, archived_by_user_id)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP(6), ?)
           ON DUPLICATE KEY UPDATE archived_at = CURRENT_TIMESTAMP(6), archived_by_user_id = VALUES(archived_by_user_id)`,
          [auth.user.clubId, eventType, item.row.id, auth.user.id],
        );
        await manager.query(
          `UPDATE chat_rooms SET archivedAt = CURRENT_TIMESTAMP(6)
           WHERE clubId = ? AND eventType = ? AND eventId = ? AND archivedAt IS NULL`,
          [auth.user.clubId, eventType, item.row.id],
        );
        await logAuditEntry(manager, {
          user: auth.user,
          entityType: eventType === 'entrainement' ? 'Entrainement' : 'Plateau',
          entityId: item.row.id,
          action: 'delete',
          before: item.event as unknown as Record<string, unknown>,
          after: null,
        });
      };

      for (const item of trainings) await prepare('entrainement', item);
      for (const item of plateaux) await prepare('plateau', item);
    });

    // Aucune notification et aucune mutation du snapshot publié ici. Les annulations
    // préparées deviennent visibles et sont notifiées une seule fois lors de la
    // publication globale.
    return NextResponse.json({ success: true, removed, pendingCancellations });
  } catch (error) {
    if (error instanceof PlanningConcurrencyError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    logError('app.unhandled', 'Error deleting recurring series:', error);
    return NextResponse.json({ error: 'Impossible de supprimer la série' }, { status: 500 });
  }
}
