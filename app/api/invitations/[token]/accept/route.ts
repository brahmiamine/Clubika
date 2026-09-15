import { NextRequest } from 'next/server';
import { handleInvitationAccept } from '@/lib/auth/invitation-accept';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } }
) {
  const resolvedParams = params instanceof Promise ? await params : params;
  return handleInvitationAccept(request, resolvedParams.token);
}
