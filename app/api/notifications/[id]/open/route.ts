import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { getDb } from '@/lib/db';
import type { NotificationEntity } from '@/lib/db/schemas';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { normalizeAccessRole } from '@/lib/auth/roles';
import { notificationDestinationHref, notificationSpace, notificationsInboxHref } from '@/lib/notifications/destinations';
import { emitNotificationsChanged } from '@/lib/realtime/hub';

/**
 * Résolveur d'identifiant opaque (issue #27) : c'est l'unique lien que les canaux
 * externes (push, email, WhatsApp) transmettent pour ouvrir une notification — jamais
 * l'URL de destination déjà résolue. Le détail réel (type, événement) n'est chargé
 * qu'ici, après authentification (`requireAuth`) et contrôle strict tenant/objet
 * (`userId = auth.user.id`, donc implicitement le club courant de la session). Une
 * notification introuvable ou appartenant à un autre compte redirige vers la boîte de
 * réception générique — sans jamais révéler si l'identifiant existe.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  const resolvedParams = params instanceof Promise ? await params : params;
  const space = notificationSpace(normalizeAccessRole(auth.user.accessRole));
  const fallbackUrl = new URL(notificationsInboxHref(space), request.url);

  const id = Number.parseInt(resolvedParams.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.redirect(fallbackUrl, { status: 302 });
  }

  try {
    const db = await getDb();
    const repo = db.getRepository<NotificationEntity>('Notification');
    // Contrôle tenant/objet : la notification doit appartenir à l'utilisateur
    // authentifié — jamais résolue pour un autre compte, même du même club.
    const notification = await repo.findOneBy({ id, userId: auth.user.id });
    if (!notification) {
      return NextResponse.redirect(fallbackUrl, { status: 302 });
    }

    if (!notification.readAt) {
      notification.readAt = new Date();
      await repo.save(notification);
      emitNotificationsChanged(auth.user.clubId, auth.user.id);
    }

    const destination = notificationDestinationHref({
      accessRole: normalizeAccessRole(auth.user.accessRole),
      type: notification.type,
      eventType: notification.eventType,
      eventId: notification.eventId,
    });
    return NextResponse.redirect(new URL(destination, request.url), { status: 302 });
  } catch (error) {
    logError('app.unhandled', 'Notification open resolution failed:', error);
    return NextResponse.redirect(fallbackUrl, { status: 302 });
  }
}
