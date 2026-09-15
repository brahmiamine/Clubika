import { NextRequest } from 'next/server';
import { handleInvitationAccept } from '@/lib/auth/invitation-accept';

/** Acceptation via le cookie de contexte, sans jeton dans l'URL (issue #34). */
export async function POST(request: NextRequest) {
  return handleInvitationAccept(request, null);
}
