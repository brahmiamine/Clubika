import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { InvitationEntity } from '@/lib/db/schemas';
import { requireRole } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { hashInvitationToken, resolveInvitationLookupId } from '@/lib/auth/invitation-tokens';
import { isClubTenantActive } from '@/lib/db/club-tenants';
import { readAppSettings } from '@/lib/settings-store';
import { loadNoticeConfig } from '@/lib/non-account-contacts/meta';
import { PRIVACY_NO_LEGAL_PROMISE } from '@/lib/non-account-contacts/constants';

// GET: public — used by the /inscription/[token] page to validate a link before signup
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> | { token: string } }
) {
  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const token = resolvedParams.token;

    const db = await getDb();
    const repo = db.getRepository<InvitationEntity>('Invitation');
    const invitation = await repo.findOneBy({ id: hashInvitationToken(token) });

    if (!invitation) {
      return NextResponse.json({ valid: false, error: 'Lien d\'invitation introuvable' }, { status: 404 });
    }
    if (invitation.usedAt) {
      return NextResponse.json({ valid: false, error: 'Ce lien a déjà été utilisé' }, { status: 410 });
    }
    if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
      return NextResponse.json({ valid: false, error: 'Ce lien a expiré' }, { status: 410 });
    }
    if (!(await isClubTenantActive(db, invitation.clubId))) {
      return NextResponse.json({ valid: false, error: 'Lien d\'invitation introuvable' }, { status: 404 });
    }

    const settings = await readAppSettings(db, invitation.clubId);
    const noticeConfig = await loadNoticeConfig(db, invitation.clubId);
    const notice = noticeConfig?.noticeVersion
      ? {
          version: noticeConfig.noticeVersion,
          text: noticeConfig.noticeText,
          disclaimer: PRIVACY_NO_LEGAL_PROMISE,
        }
      : null;

    return NextResponse.json({
      valid: true,
      email: invitation.email,
      accessRole: invitation.accessRole,
      planningFunctions: invitation.planningFunctions,
      personNom: invitation.personNom,
      notice,
      club: {
        name: settings.clubName,
        logo: settings.clubLogo,
        primaryColor: settings.primaryColor,
        accentColor: settings.accentColor,
        themeMode: settings.themeMode,
      },
    });
  } catch (error) {
    console.error('Error validating invitation:', error);
    return NextResponse.json({ valid: false, error: 'Une erreur est survenue' }, { status: 500 });
  }
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
    console.error('Error revoking invitation:', error);
    return NextResponse.json({ error: 'Failed to revoke invitation' }, { status: 500 });
  }
}
