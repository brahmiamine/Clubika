import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/require';
import { listExternalServiceStatuses } from '@/lib/compliance/external-services';
import { setCurrentClubId } from '@/lib/auth/club-context';

const ADMIN_ONLY = ['admin'] as const;

export async function GET(request: NextRequest) {
  const auth = await requireRole(request, [...ADMIN_ONLY]);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);
  return NextResponse.json({
    services: listExternalServiceStatuses(),
    notice:
      'Chaque flux sortant est désactivé tant que son drapeau d’environnement n’est pas posé. Désactiver une intégration n’efface aucune donnée. L’activation réelle attend un contrat/DPA et la revue #12/#40.',
  });
}
