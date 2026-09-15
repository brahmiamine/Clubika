import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { InvitationEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { resolveInvitationLookupId } from '@/lib/auth/invitation-tokens';
import { validateInvitationFromUrlToken } from '@/lib/auth/invitation-public';

// GET: public — validation minimale avant inscription (issue #34).
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } }
) {
  const resolvedParams = params instanceof Promise ? await params : params;
  return validateInvitationFromUrlToken(request, resolvedParams.token);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } }
) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) {
    return auth.error;
  }
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const token = resolvedParams.token;

    const db = await getDb();
    const repo = db.getRepository<InvitationEntity>('Invitation');
    const invitation = await repo.findOneBy({ id: resolveInvitationLookupId(token), clubId: auth.user.clubId });
    if (!invitation) {
      return NextResponse.json({ error: 'Invitation non trouvée' }, { status: 404 });
    }

    await repo.remove(invitation);

    return NextResponse.json({ success: true });
  } catch (error) {
    logError('app.unhandled', 'Error revoking invitation:', error);
    return NextResponse.json({ error: 'Failed to revoke invitation' }, { status: 500 });
  }
}
