import { describe, expect, it } from 'vitest';
import { notificationDestinationHref } from './destinations';

/**
 * Matrice des événements métier notifiés (issue #321, alignée #388).
 * Chaque ligne vérifie destinataire (via le `type`) + deep-link.
 */
const MATRIX: Array<{
  type: string;
  eventType: string | null;
  eventId: string | null;
  adminHref: string;
  personalHref: string;
}> = [
  { type: 'planning-published-added', eventType: 'amical', eventId: 'e1', adminHref: '/club/evenements/amical/e1?from=planning', personalHref: '/mon-planning/evenements/amical/e1' },
  { type: 'planning-published-removed', eventType: 'officiel', eventId: 'e2', adminHref: '/club/evenements/officiel/e2?from=planning', personalHref: '/mon-planning/evenements/officiel/e2' },
  { type: 'planning-published-rescheduled', eventType: 'entrainement', eventId: 'e3', adminHref: '/club/evenements/entrainement/e3?from=planning', personalHref: '/mon-planning/evenements/entrainement/e3' },
  { type: 'planning-published-cancelled', eventType: 'plateau', eventId: 'e4', adminHref: '/club/evenements/plateau/e4?from=planning', personalHref: '/mon-planning/evenements/plateau/e4' },
  { type: 'planning-published-reconfirmation-required', eventType: 'amical', eventId: 'e5', adminHref: '/club/evenements/amical/e5?from=planning', personalHref: '/mon-planning/evenements/amical/e5' },
  { type: 'assignment-response', eventType: 'amical', eventId: 'm2', adminHref: '/club/evenements/amical/m2?from=planning', personalHref: '/mon-planning/evenements/amical/m2' },
  { type: 'assignment-replacement-required', eventType: 'amical', eventId: 'm2', adminHref: '/club/evenements/amical/m2?from=planning', personalHref: '/mon-planning/evenements/amical/m2' },
  { type: 'assignment-reminder-manual', eventType: 'officiel', eventId: 'm3', adminHref: '/club/evenements/officiel/m3?from=planning', personalHref: '/mon-planning/evenements/officiel/m3' },
  { type: 'assignment-swap-requested', eventType: 'officiel', eventId: 'm4', adminHref: '/club/evenements/officiel/m4?from=planning', personalHref: '/mon-planning/evenements/officiel/m4' },
  { type: 'assignment-swap-cancelled', eventType: 'officiel', eventId: 'm4', adminHref: '/club/evenements/officiel/m4?from=planning', personalHref: '/mon-planning/evenements/officiel/m4' },
  { type: 'assignment-swap-admin-review', eventType: 'officiel', eventId: 'm4', adminHref: '/club/evenements/officiel/m4?from=planning', personalHref: '/mon-planning/evenements/officiel/m4' },
  { type: 'official_match_updated', eventType: null, eventId: null, adminHref: '/club/planning', personalHref: '/mon-planning/notifications' },
  { type: 'official_match_cancelled', eventType: null, eventId: null, adminHref: '/club/planning', personalHref: '/mon-planning/notifications' },
  { type: 'availability-updated', eventType: 'indisponibilite', eventId: '42', adminHref: '/club/indisponibilites?userId=42', personalHref: '/mon-planning/notifications' },
  { type: 'availability-reviewed', eventType: 'indisponibilite', eventId: 'ind-1', adminHref: '/club/notifications', personalHref: '/mon-planning/mes-indisponibilites' },
  { type: 'planning-preferences-updated', eventType: null, eventId: null, adminHref: '/club/notifications', personalHref: '/mon-planning/notifications' },
  { type: 'post-event-report', eventType: 'officiel', eventId: 'm5', adminHref: '/club/evenements/officiel/m5?from=planning', personalHref: '/mon-planning/evenements/officiel/m5' },
  { type: 'user-deactivated-with-assignments', eventType: null, eventId: null, adminHref: '/club/planning', personalHref: '/mon-planning/notifications' },
  { type: 'account-closure-requested', eventType: null, eventId: null, adminHref: '/club/utilisateurs', personalHref: '/mon-planning/notifications' },
  { type: 'account-closure-processed', eventType: null, eventId: null, adminHref: '/club/utilisateurs', personalHref: '/mon-planning/notifications' },
  { type: 'minor-account-erroneous-closure', eventType: null, eventId: null, adminHref: '/club/utilisateurs', personalHref: '/mon-planning/notifications' },
  { type: 'chat-dm', eventType: 'chat', eventId: 'room-dm', adminHref: '/club/chat?roomId=room-dm', personalHref: '/mon-planning/chat?roomId=room-dm' },
  { type: 'chat-event-message', eventType: 'chat', eventId: 'room-evt', adminHref: '/club/chat?roomId=room-evt', personalHref: '/mon-planning/chat?roomId=room-evt' },
  { type: 'chat-mention', eventType: 'chat', eventId: 'room-ch', adminHref: '/club/chat?roomId=room-ch', personalHref: '/mon-planning/chat?roomId=room-ch' },
];

describe('matrice notifications (issue #321)', () => {
  it.each(MATRIX)('$type deep-link admin/personnel', ({ type, eventType, eventId, adminHref, personalHref }) => {
    expect(notificationDestinationHref({ accessRole: 'admin', type, eventType, eventId })).toBe(adminHref);
    expect(notificationDestinationHref({ accessRole: 'dirigeant', type, eventType, eventId })).toBe(personalHref);
    expect(adminHref).not.toBe('/notifications');
    expect(personalHref).not.toBe('/notifications');
  });
});
