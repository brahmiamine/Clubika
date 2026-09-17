import type { UserReferenceReport } from '@/lib/planning/user-references';

/**
 * Politique produit de conservation après fermeture (issue #11).
 *
 * Aucune base légale n'est inventée ici : pas d'archive nominative, pas
 * d'échéance juridique. Ce qui reste est soit un stub technique sans identité,
 * soit des données opérationnelles du club déjà visibles d'autres personnes,
 * avec le nom remplacé par « Utilisateur supprimé ». Les durées d'effacement
 * de ces contenus relèvent de #9 ; le traitement des messages qui peuvent
 * encore identifier quelqu'un par leur texte est soumis à revue (#12).
 */

/**
 * `'minor-erroneous'` (issue #18) : fermeture déclenchée par le traitement dédié d'un
 * compte mineur créé par erreur (V1 réservée aux adultes du staff), distincte d'une
 * fermeture standard demandée par le titulaire (`'self'`) ou décidée par un
 * administrateur pour un autre motif (`'admin'`) — même mécanique de suspension et
 * d'anonymisation, mais tracée séparément dans `account_closures.processed_by_role`
 * pour l'audit de conformité.
 */
export type AccountClosureRole = 'self' | 'admin' | 'minor-erroneous';

export interface RetainedCategory {
  category: string;
  kept: boolean;
  justification: string;
}

export interface AccountClosurePreview {
  displayName: string;
  retained: RetainedCategory[];
  references: string[];
}

export function retainedCategoriesForClosure(input: {
  references: UserReferenceReport;
  authoredOperationalRecords: boolean;
}): RetainedCategory[] {
  const chat = input.references.reasons.some((reason) => reason.includes('chat'));
  const planning = input.references.reasons.some((reason) =>
    reason.includes('planning') || reason.includes('événement') || reason.includes('enregistrement'),
  );

  return [
    {
      category: 'stub-row',
      kept: true,
      justification:
        'Ligne technique conservée pour les clés étrangères. Aucune identité nominative (nom, e-mail, téléphone, mot de passe) n’y figure.',
    },
    {
      category: 'chat-message-bodies',
      kept: chat,
      justification: chat
        ? 'Le contenu des messages reste visible des autres participants ; seuls les noms d’affichage sont remplacés. Durée d’effacement = politique produit (#9). Traitement des contenus encore identifiants : revue #12, aucune base légale inventée.'
        : 'Aucune participation à une conversation de chat.',
    },
    {
      category: 'planning-history',
      kept: planning,
      justification: planning
        ? 'Affectations et historique opérationnels du club, avec le nom remplacé par « Utilisateur supprimé ». Pas de conservation d’identité pour satisfaire une référence SQL.'
        : 'Aucune référence d’affectation ou d’enregistrement de planning.',
    },
    {
      category: 'authored-operational-records',
      kept: input.authoredOperationalRecords,
      justification: input.authoredOperationalRecords
        ? 'Commentaires, rapports ou échanges d’affectation déjà visibles du club : le nom d’auteur est anonymisé, le texte n’est pas réécrit. Durée = #9.'
        : 'Aucun enregistrement opérationnel rédigé par ce compte.',
    },
  ];
}

export function accountClosurePreview(
  references: UserReferenceReport,
  authoredOperationalRecords: boolean,
): AccountClosurePreview {
  return {
    displayName: 'Utilisateur supprimé',
    retained: retainedCategoriesForClosure({ references, authoredOperationalRecords }),
    references: references.reasons,
  };
}

export function closureSummaryHasPii(summary: { retained: RetainedCategory[]; references: string[] }): boolean {
  const blob = JSON.stringify(summary).toLowerCase();
  return blob.includes('@') && blob.includes('.');
}
