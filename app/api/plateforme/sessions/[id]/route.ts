import { NextRequest, NextResponse } from 'next/server';
import { requirePlatformAuth } from '@/lib/auth/platform-require';
import { revokePlatformSessionById } from '@/lib/auth/platform-session';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requirePlatformAuth(request);
  if ('error' in auth) return auth.error;

  const resolved = params instanceof Promise ? await params : params;
  const sessionId = resolved.id?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 });
  }

  const revoked = await revokePlatformSessionById(auth.admin.id, sessionId);
  if (!revoked) {
    return NextResponse.json({ error: 'Session introuvable' }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
