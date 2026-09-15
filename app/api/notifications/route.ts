import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { NotificationEntity } from '@/lib/db/schemas';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { normalizeAccessRole } from '@/lib/auth/roles';
import { notificationDestinationHref } from '@/lib/notifications/destinations';
import { listPublishedPlanningEventSnapshots } from '@/lib/planning/published-planning';
import { createTeamLogoResolver } from '@/lib/planning/team-logos';
import { CHAT_INBOX_EXCLUDED_TYPES } from '@/lib/notifications/inbox';
import { emitNotificationsChanged } from '@/lib/realtime/hub';

function parseLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(parsed, 1), 100);
}

function parseBeforeId(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const url = new URL(request.url);
    const limit = parseLimit(url.searchParams.get('limit'));
    const beforeId = parseBeforeId(url.searchParams.get('beforeId'));

    const db = await getDb();
    const repo = db.getRepository<NotificationEntity>('Notification');
    const qb = repo.createQueryBuilder('notification')
      .where('notification.userId = :userId', { userId: auth.user.id })
      .andWhere('notification.type NOT IN (:...excludedTypes)', { excludedTypes: [...CHAT_INBOX_EXCLUDED_TYPES] })
      .orderBy('notification.createdAt', 'DESC')
      .addOrderBy('notification.id', 'DESC')
      .take(limit + 1);
    if (beforeId !== null) {
      qb.andWhere('notification.id < :beforeId', { beforeId });
    }
    const fetched = await qb.getMany();
    const hasMore = fetched.length > limit;
    const notifications = hasMore ? fetched.slice(0, limit) : fetched;

    const unread = await repo
      .createQueryBuilder('notification')
      .where('notification.userId = :userId', { userId: auth.user.id })
      .andWhere('notification.readAt IS NULL')
      .andWhere('notification.type NOT IN (:...excludedTypes)', { excludedTypes: [...CHAT_INBOX_EXCLUDED_TYPES] })
      .getCount();

    // Notifications liées à un match : on joint les logos des deux clubs pour un
    // rendu visuel côté /mon-planning. Best-effort, et uniquement quand l'appelant
    // le demande (`?withLogos=1`) pour ne pas alourdir le simple compteur non-lus.
    const withLogos = url.searchParams.get('withLogos') === '1';
    let payload: unknown[] = notifications;
    if (withLogos && notifications.some((item) => item.eventType && item.eventId)) {
      try {
        const [snapshots, resolveLogos] = await Promise.all([
          listPublishedPlanningEventSnapshots(db, auth.user.clubId),
          createTeamLogoResolver(db, auth.user.clubId),
        ]);
        type ResolvableEvent = Parameters<typeof resolveLogos>[0];
        const eventByKey = new Map<string, ResolvableEvent>();
        for (const snapshot of snapshots ?? []) {
          eventByKey.set(`${snapshot.eventType}:${snapshot.eventId}`, snapshot.event as ResolvableEvent);
        }
        payload = notifications.map((item) => {
          const base = item.eventType && item.eventId
            ? { ...item, ...resolveLogos(eventByKey.get(`${item.eventType}:${item.eventId}`)) }
            : item;
          return {
            ...base,
            clubId: auth.user.clubId,
            href: notificationDestinationHref({
              accessRole: normalizeAccessRole(auth.user.accessRole),
              type: item.type,
              eventType: item.eventType,
              eventId: item.eventId,
            }),
          };
        });
      } catch (enrichError) {
        logError('app.unhandled', 'Notification logo enrichment failed:', enrichError);
      }
    }

    if (payload === notifications) {
      payload = notifications.map((item) => ({
        ...item,
        clubId: auth.user.clubId,
        href: notificationDestinationHref({
          accessRole: normalizeAccessRole(auth.user.accessRole),
          type: item.type,
          eventType: item.eventType,
          eventId: item.eventId,
        }),
      }));
    }

    const nextBeforeId = hasMore ? notifications[notifications.length - 1]?.id ?? null : null;
    return NextResponse.json({ notifications: payload, unread, hasMore, nextBeforeId });
  } catch (error) {
    logError('app.unhandled', 'Error loading notifications:', error);
    return NextResponse.json({ error: 'Impossible de charger les notifications' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const body = await request.json();
    const db = await getDb();
    const repo = db.getRepository<NotificationEntity>('Notification');

    if (body.all === true) {
      await repo
        .createQueryBuilder()
        .update()
        .set({ readAt: new Date() })
        .where('userId = :userId', { userId: auth.user.id })
        .andWhere('readAt IS NULL')
        .andWhere('type NOT IN (:...excludedTypes)', { excludedTypes: [...CHAT_INBOX_EXCLUDED_TYPES] })
        .execute();
      emitNotificationsChanged(auth.user.clubId, auth.user.id);
      return NextResponse.json({ success: true });
    }

    const id = Number.parseInt(String(body.id ?? ''), 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Notification invalide' }, { status: 400 });
    }

    const notification = await repo.findOneBy({ id, userId: auth.user.id });
    if (!notification) return NextResponse.json({ error: 'Notification introuvable' }, { status: 404 });
    notification.readAt = new Date();
    await repo.save(notification);
    emitNotificationsChanged(auth.user.clubId, auth.user.id);
    return NextResponse.json({ success: true });
  } catch (error) {
    logError('app.unhandled', 'Error updating notification:', error);
    return NextResponse.json({ error: 'Impossible de mettre à jour la notification' }, { status: 500 });
  }
}
