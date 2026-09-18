import { logError } from '@/lib/observability/log';
import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireRole } from '@/lib/auth/require';
import { setCurrentClubId } from '@/lib/auth/club-context';
import { revokeAllSessionsForUser } from '@/lib/auth/session';
import { notifyAdmins } from '@/lib/notifications/service';
import {
  AccountClosureError,
  closeAccount,
  countLockedActiveAdmins,
  lockTargetAndActiveAdmins,
} from '@/lib/account-closure/close-account';

/**
 * Traitement dédié d'un compte mineur créé par erreur (issue #18).
 *
 * La V1 de Clubika réserve les comptes au staff majeur ; si un compte s'avère
 * appartenir à une personne mineure (signalement, erreur de saisie…), ce point
 * d'entrée applique les trois volets décidés par le ticket :
 *
 *  1. **Suspension immédiate** : le compte est désactivé et toutes ses sessions
 *     actives sont révoquées — la personne ne peut plus se connecter dès l'appel.
 *  2. **Information** : les administrateurs actifs du club reçoivent une
 *     notification traçable (qui, quand, motif) pour l'audit de conformité.
 *  3. **Effacement** : l'identité est anonymisée via le mécanisme d'effacement déjà
 *     en production pour la fermeture de compte (`closeAccount`), pas une
 *     suppression physique — la même politique de conservation minimale (#11)
 *     s'applique, sans inventer de base légale nouvelle pour ce cas particulier.
 *
 * Ce que ce point d'entrée ne fait volontairement PAS, faute de décision produit
 * ou juridique disponible : prévenir directement la personne mineure (ou un tuteur
 * légal) par un canal de contact non vérifié, ni ouvrir de fenêtre de contestation
 * avant effacement. Ces points restent des questions ouvertes pour la revue
 * juridique et de conception séparée demandée par l'issue #18 avant toute ouverture
 * aux mineurs — rien n'est tranché ici à leur place.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  const auth = await requireRole(request, ['admin']);
  if ('error' in auth) return auth.error;
  setCurrentClubId(auth.user.clubId);

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const id = Number.parseInt(resolvedParams.id, 10);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ error: 'Identifiant invalide' }, { status: 400 });
    }

    const db = await getDb();
    const outcome = await db.transaction(async (manager) => {
      const locked = await lockTargetAndActiveAdmins(manager, auth.user.clubId, id);
      const target = locked.find((candidate) => candidate.id === id);
      if (!target) return { kind: 'not-found' as const };

      // Nom capturé avant anonymisation, uniquement pour la notification interne
      // ci-dessous — jamais persisté ni renvoyé au-delà de cet appel.
      const displayNameBeforeErasure = target.nom;

      try {
        const result = await closeAccount(manager, {
          target,
          processedByUserId: auth.user.id,
          processedByRole: 'minor-erroneous',
          activeAdminCount: countLockedActiveAdmins(locked),
        });
        return {
          kind: result.alreadyClosed ? ('already-closed' as const) : ('ok' as const),
          result,
          displayNameBeforeErasure,
        };
      } catch (error) {
        if (error instanceof AccountClosureError && error.code === 'last-admin') {
          return { kind: 'last-admin' as const };
        }
        throw error;
      }
    });

    if (outcome.kind === 'not-found') {
      return NextResponse.json({ error: 'Utilisateur non trouvé' }, { status: 404 });
    }
    if (outcome.kind === 'last-admin') {
      return NextResponse.json(
        { error: 'Impossible de fermer le dernier administrateur : transférez d’abord le rôle à un autre compte.' },
        { status: 400 },
      );
    }

    await revokeAllSessionsForUser(outcome.result.userId);

    if (outcome.kind === 'ok') {
      await notifyAdmins(db, {
        type: 'minor-account-erroneous-closure',
        title: 'Compte mineur créé par erreur : suspendu et effacé',
        message: `Le compte « ${outcome.displayNameBeforeErasure} » a été suspendu et anonymisé par ${auth.user.nom}, `
          + 'la personne s\'étant révélée mineure. La V1 de Clubika est réservée aux adultes du staff (issue #18).',
      });
    }

    return NextResponse.json({ success: true, closure: outcome.result });
  } catch (error) {
    logError('app.unhandled', 'Error closing erroneous minor account:', error);
    return NextResponse.json({ error: 'Failed to close user account' }, { status: 500 });
  }
}
