import { createHash } from 'node:crypto';
import { canEdit, type ClubAccessRole } from '@/lib/auth/roles';

export type ChatRoomType = 'direct' | 'event' | 'channel';

export interface ChatPolicyUser {
  id: number;
  clubId: string;
  accessRole: ClubAccessRole;
}

export interface ChatPolicyRoom {
  type: ChatRoomType;
  clubId: string;
  createdByUserId: number;
}

/**
 * Politique d'accès aux salons chat.
 *
 * - **direct** / **channel** : participants explicitement inscrits au salon.
 * - **event** (issue #345) : comptes ayant accepté l'affectation sur le snapshot
 *   publié uniquement ; les administrateurs conservent l'accès modération. Sans
 *   accès club-wide après désaffectation, ni pour une affectation en attente ou refusée.
 */
export function canAccessChatRoom(
  user: ChatPolicyUser,
  room: ChatPolicyRoom,
  participantUserIds: readonly number[],
  eventAssignedUserIds: readonly number[] = [],
): boolean {
  if (user.clubId !== room.clubId) return false;
  if (room.type === 'event') {
    if (canEdit(user.accessRole)) return true;
    return eventAssignedUserIds.includes(user.id);
  }
  return participantUserIds.includes(user.id);
}

export function canManageChatChannel(user: ChatPolicyUser, room: ChatPolicyRoom): boolean {
  return room.type === 'channel' && user.clubId === room.clubId && user.accessRole === 'admin';
}

export function isClubika(userClubId: string, clubId: string): boolean {
  return userClubId === clubId;
}

function conversationKey(parts: readonly (string | number)[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function directConversationKey(clubId: string, firstUserId: number, secondUserId: number): string {
  const [low, high] = [firstUserId, secondUserId].sort((a, b) => a - b) as [number, number];
  return conversationKey(['direct', clubId, low, high]);
}

export function eventConversationKey(clubId: string, eventType: string, eventId: string): string {
  return conversationKey(['event', clubId, eventType, eventId]);
}
