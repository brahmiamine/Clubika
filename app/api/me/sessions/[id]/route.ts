import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/require';
import { revokeSessionById } from '@/lib/auth/session';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireAuth(request);
  if ('error' in auth) return auth.error;

  const resolved = params instanceof Promise ? await params : params;
  const sessionId = resolved.id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 });
  }

  const revoked = await revokeSessionById(auth.user.id, sessionId);
  if (!revoked) {
    return NextResponse.json({ error: 'Session introuvable' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
