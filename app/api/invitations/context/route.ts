import { NextRequest } from 'next/server';
import { validateInvitationFromContextCookie } from '@/lib/auth/invitation-public';

export async function GET(request: NextRequest) {
  return validateInvitationFromContextCookie(request);
}
