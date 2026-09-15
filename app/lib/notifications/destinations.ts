import type { ClubAccessRole } from '@/lib/auth/roles';
import {
  eventWorkspaceHref,
  personalEventWorkspaceHref,
  type PlanningEventLinkType,
} from '@/lib/planning/event-links';

export type NotificationSpace = 'club' | 'personal';

const PLANNING_EVENT_TYPES = new Set<PlanningEventLinkType>(['officiel', 'amical', 'entrainement', 'plateau']);

export function notificationSpace(accessRole: ClubAccessRole | null | undefined): NotificationSpace {
  return accessRole === 'admin' ? 'club' : 'personal';
}

export function notificationsInboxHref(space: NotificationSpace): string {
  return space === 'club' ? '/club/notifications' : '/mon-planning/notifications';
}

export function chatRoomHref(space: NotificationSpace, roomId: string): string {
  const base = space === 'club' ? '/club/chat' : '/mon-planning/chat';
  return `${base}?roomId=${encodeURIComponent(roomId)}`;
}

export function indisponibilitesHref(space: NotificationSpace, userId?: string | null): string {
  if (space === 'club') {
    const base = '/club/indisponibilites';
    return userId ? `${base}?userId=${encodeURIComponent(userId)}` : base;
  }
  return '/mon-planning/mes-indisponibilites';
}

export function planningListHref(space: NotificationSpace): string {
  return space === 'club' ? '/club/planning' : '/mon-planning';
}

function isPlanningEventType(value: string): value is PlanningEventLinkType {
  return PLANNING_EVENT_TYPES.has(value as PlanningEventLinkType);
}

function destinationForNotificationType(type: string | null, space: NotificationSpace): string | null {
  switch (type) {
    case 'availability-updated':
      return space === 'club' ? indisponibilitesHref('club') : null;
    case 'availability-reviewed':
      return space === 'personal' ? indisponibilitesHref('personal') : null;
    case 'official_match_updated':
    case 'official_match_cancelled':
    case 'user-deactivated-with-assignments':
      return space === 'club' ? planningListHref('club') : null;
    case 'account-closure-requested':
    case 'account-closure-processed':
      return space === 'club' ? '/club/utilisateurs' : null;
    default:
      return null;
  }
}

/**
 * Destination réelle d'une notification (issue #321) : plus jamais `/notifications`,
 * qui n'existe pas. Chat → salon, événement de planning → espace événement,
 * indisponibilités / planning selon le type, sinon inbox.
 */
export function notificationDestinationHref(input: {
  accessRole?: ClubAccessRole | null;
  type?: string | null;
  eventType?: string | null;
  eventId?: string | null;
}): string {
  const space = notificationSpace(input.accessRole);
  const type = input.type?.trim() || null;
  const eventType = input.eventType?.trim() || null;
  const eventId = input.eventId?.trim() || null;

  if (eventType === 'chat' && eventId) {
    return chatRoomHref(space, eventId);
  }

  if (eventType === 'indisponibilite') {
    if (type === 'availability-updated' && space === 'club') {
      return indisponibilitesHref('club', eventId);
    }
    if (type === 'availability-reviewed' && space === 'personal') {
      return indisponibilitesHref('personal');
    }
  }

  if (eventType && eventId && isPlanningEventType(eventType)) {
    return space === 'club'
      ? eventWorkspaceHref(eventType, eventId)
      : personalEventWorkspaceHref(eventType, eventId);
  }

  const typedDestination = destinationForNotificationType(type, space);
  if (typedDestination) return typedDestination;

  return notificationsInboxHref(space);
}

export const FALLBACK_PUSH_NOTIFICATION_URL = '/club/notifications';

/** Message SW → page : ouvrir la destination d’une notification cliquée (PWA mobile). */
export const NOTIFICATION_NAVIGATE_SW_TYPE = 'notification-navigate';

export function appPathFromNotificationUrl(rawUrl: string, origin: string): string | null {
  try {
    const url = new URL(rawUrl, origin);
    if (url.origin !== new URL(origin).origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function notificationNavigateHref(payload: unknown, origin: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as { type?: unknown; url?: unknown };
  if (data.type !== NOTIFICATION_NAVIGATE_SW_TYPE) return null;
  if (typeof data.url !== 'string') return null;
  const url = data.url.trim();
  if (!url) return null;
  return appPathFromNotificationUrl(url, origin);
}
