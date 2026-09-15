import { logError } from '@/lib/observability/log';
import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { WRITE_ROLES } from '@/lib/auth/roles';
import type { Entrainement, Plateau } from '@/types/match';
import type { EntrainementEntity, PlateauEntity } from '@/lib/db/schemas';
import { enrichAssignmentContacts } from '@/lib/planning/assignment-contacts';
import { logAuditEntry } from '@/lib/db/audit-log';
import { planningFeatureGuard } from '@/lib/planning/feature-guard';
import { setCurrentClubId } from '@/lib/auth/club-context';
import {
  parseEntrainementPayload,
  parsePlateauPayload,
  serializeEntrainementPayload,
  serializePlateauPayload,
} from '@/lib/db/planning-payload-codecs';

function parseInputDate(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const db = await getDb();
  const disabled = await planningFeatureGuard(db, 'recurringEvents');
  if (disabled) return disabled;
  const [trainings, plateaux] = await Promise.all([
    db.getRepository<EntrainementEntity>('Entrainement').findBy({ clubId: auth.user.clubId }),
    db.getRepository<PlateauEntity>('Plateau').findBy({ clubId: auth.user.clubId }),
  ]);

  const groups = new Map<string, { seriesId: string; eventType: 'entrainement' | 'plateau'; count: number; firstDate: string; lastDate: string; time: string; lieu: string }>();
  const add = (event: Entrainement | Plateau, eventType: 'entrainement' | 'plateau') => {
    if (!event.seriesId || event.planningStatus === 'cancelled') return;
    const existing = groups.get(event.seriesId);
    if (!existing) {
      groups.set(event.seriesId, { seriesId: event.seriesId, eventType, count: 1, firstDate: event.date, lastDate: event.date, time: event.time, lieu: event.lieu });
      return;
    }
    existing.count += 1;
    existing.lastDate = event.date;
  };
  trainings.forEach((row) => add(parseEntrainementPayload(row.payload, row.id), 'entrainement'));
  plateaux.forEach((row) => add(parsePlateauPayload(row.payload, row.id), 'plateau'));

  return NextResponse.json({ series: Array.from(groups.values()) });
}

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, WRITE_ROLES);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const db = await getDb();
    const disabled = await planningFeatureGuard(db, 'recurringEvents');
    if (disabled) return disabled;
    const body = await request.json();
    const eventType = body.eventType;
    if (eventType !== 'entrainement' && eventType !== 'plateau') {
      return NextResponse.json({ error: 'Type de série invalide' }, { status: 400 });
    }

    const start = typeof body.startDate === 'string' ? parseInputDate(body.startDate) : null;
    const end = typeof body.endDate === 'string' ? parseInputDate(body.endDate) : null;
    if (!start || !end || end.getTime() < start.getTime()) {
      return NextResponse.json({ error: 'Période de récurrence invalide' }, { status: 400 });
    }
    if (typeof body.time !== 'string' || !/^\d{2}:\d{2}$/.test(body.time)) {
      return NextResponse.json({ error: 'Horaire invalide' }, { status: 400 });
    }
    if (typeof body.lieu !== 'string' || !body.lieu.trim()) {
      return NextResponse.json({ error: 'Lieu requis' }, { status: 400 });
    }

    const frequencyWeeks = Number.isFinite(body.frequencyWeeks)
      ? Math.min(8, Math.max(1, Math.round(body.frequencyWeeks)))
      : 1;
    const durationMinutes = Number.isFinite(body.durationMinutes)
      ? Math.min(720, Math.max(15, Math.round(body.durationMinutes)))
      : eventType === 'plateau' ? 120 : 90;
    const seriesId = `series-${randomBytes(8).toString('hex')}`;
    const encadrants = await enrichAssignmentContacts(db, auth.user.clubId, body.encadrants, 'encadrant');
    const events: Array<Entrainement | Plateau> = [];

    for (let cursor = new Date(start); cursor.getTime() <= end.getTime(); cursor.setUTCDate(cursor.getUTCDate() + frequencyWeeks * 7)) {
      if (events.length >= 80) {
        return NextResponse.json({ error: 'Une série est limitée à 80 occurrences' }, { status: 400 });
      }
      const date = formatDate(cursor);
      const suffix = `${date.replace(/\//g, '-')}-${body.time.replace(':', '-')}-${events.length + 1}`;
      if (eventType === 'entrainement') {
        events.push({
          id: `entrainement-${seriesId}-${suffix}`,
          type: 'entrainement',
          date,
          time: body.time,
          lieu: body.lieu.trim(),
          categorie: typeof body.categorie === 'string' && body.categorie.trim() ? body.categorie.trim() : undefined,
          durationMinutes,
          seriesId,
          planningStatus: 'draft',
          encadrants,
        });
      } else {
        const categories = Array.isArray(body.categories)
          ? body.categories.filter((value: unknown): value is string => typeof value === 'string' && value.trim() !== '').map((value: string) => value.trim())
          : [];
        events.push({
          id: `plateau-${seriesId}-${suffix}`,
          type: 'plateau',
          date,
          time: body.time,
          lieu: body.lieu.trim(),
          categories,
          durationMinutes,
          seriesId,
          planningStatus: 'draft',
          encadrants,
        });
      }
    }

    if (eventType === 'entrainement') {
      await db.transaction(async (manager) => {
        const typedEvents = events as Entrainement[];
        await manager.getRepository<EntrainementEntity>('Entrainement').save(typedEvents.map((event) => ({
          id: event.id, clubId: auth.user.clubId, date: event.date, time: event.time, payload: serializeEntrainementPayload(event),
        })));
        for (const event of typedEvents) {
          await logAuditEntry(manager, {
            user: auth.user, entityType: 'Entrainement', entityId: event.id,
            action: 'create', before: null, after: event as unknown as Record<string, unknown>,
          });
        }
      });
    } else {
      await db.transaction(async (manager) => {
        const typedEvents = events as Plateau[];
        await manager.getRepository<PlateauEntity>('Plateau').save(typedEvents.map((event) => ({
          id: event.id, clubId: auth.user.clubId, date: event.date, time: event.time, payload: serializePlateauPayload(event),
        })));
        for (const event of typedEvents) {
          await logAuditEntry(manager, {
            user: auth.user, entityType: 'Plateau', entityId: event.id,
            action: 'create', before: null, after: event as unknown as Record<string, unknown>,
          });
        }
      });
    }
    return NextResponse.json({ success: true, seriesId, count: events.length, planningStatus: 'draft' });
  } catch (error) {
    logError('app.unhandled', 'Error creating recurring events:', error);
    return NextResponse.json({ error: 'Impossible de créer la série' }, { status: 500 });
  }
}
