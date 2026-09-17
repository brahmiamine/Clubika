# Auto-affectation du planning (issue #15)

L’API `/api/planning/auto-assign` est un **outil interne d’administration** (rôles
d’écriture uniquement). Comme `/api/planning/waitlist`, aucun parcours frontend public
n’en dépend encore ; un appel direct par un administrateur reste néanmoins possible et
suit les mêmes garanties que le reste du planning.

## Séparation suggestion / confirmation

- `GET` : calcule et renvoie des **suggestions** (candidats, score, raisons) pour un rôle
  vacant ou à remplacer. **Lecture seule** — n’écrit jamais, ne modifie jamais le planning
  et ne crée aucune entrée d’audit.
- `POST` : **confirme** une affectation. Exige un `personId` explicite dans le corps de
  la requête ; son absence renvoie `400`. Il n’existe aucun choix implicite du premier
  candidat de la liste — l’administrateur doit désigner la personne.

Les deux routes sont couvertes par le flag `autoAssignment` (voir
`app/lib/planning/feature-surfaces.ts`) : si la fonctionnalité est désactivée, les deux
répondent `409` sans effet.

## Revalidation à la confirmation

Le `POST` ne fait jamais confiance à une liste de suggestions affichée précédemment à
l’admin (elle a pu devenir obsolète entre-temps). Au moment de la confirmation, il :

1. recharge un instantané frais de l’événement ;
2. recalcule intégralement les suggestions (`buildAssignmentSuggestions`) — disponibilité,
   conflits, charge et éligibilité à la fonction sont donc revérifiés à cet instant, pas
   seulement au moment où les suggestions ont été affichées ;
3. refuse `409` si le `personId` demandé n’apparaît plus dans ce recalcul (devenu
   indisponible, en conflit, en surcharge ou non éligible) ;
4. enregistre l’affectation via `saveRoleAssignments`, qui verrouille la ligne concernée
   et compare la révision réellement persistée à celle lue en (1) : une confirmation
   concurrente sur le même événement échoue `409` (`PlanningConcurrencyError`) plutôt que
   d’écraser silencieusement l’autre affectation.

## Critères pris en compte par l’algorithme (`buildAssignmentSuggestions`)

Pour chaque personne tenant la fonction requise par le rôle (arbitre club, encadrant,
accompagnateur) et active dans le club :

- **Disponibilité** : indisponibilités déclarées sur le créneau de l’événement.
- **Conflit** : autre affectation active (tout rôle confondu, y compris en brouillon) qui
  chevauche le créneau, avec une marge de 30 minutes.
- **Charge** : nombre d’affectations sur les 30 derniers jours, affectations à venir, et
  charge le même jour — chacune pénalise le score.
- **Préférences personnelles** (si renseignées) : catégories, jours, créneaux, lieux
  préférés, plafond hebdomadaire d’affectations, durée de trajet maximale acceptée entre
  deux événements le même jour.
- **Éligibilité fonctionnelle** : seules les personnes tenant la fonction associée au rôle
  sont candidates.

Le score (0 à 100) et une liste de raisons lisibles (`reasons`) accompagnent chaque
candidat pour que l’administrateur comprenne le classement avant de choisir.

## Limites connues

- Le calcul ne retient que les 20 meilleurs candidats par défaut (`limit`, plafonné à 20).
  Une personne éligible mais hors de ce top 20 n’apparaîtra pas dans les suggestions.
- Aucune information de classement ou de profilage n’est conservée au-delà de la requête :
  seule l’affectation confirmée (personne choisie, score au moment de la confirmation) est
  journalisée dans l’audit, jamais la liste complète des candidats évalués ni leurs
  raisons. Cette entrée suit ensuite la purge de rétention standard des journaux d’audit
  (voir `docs/retention.md`).
- L’algorithme ne tient pas compte de critères qualitatifs (compétence, affinité,
  historique disciplinaire, etc.) : c’est un outil d’aide à la décision, pas une décision
  automatique.
- Aucun classement ou score individuel n’est exposé publiquement : ces routes sont
  réservées aux rôles d’écriture (administration du club).

## Affectation manuelle hors suggestion

L’algorithme de suggestion n’est pas la seule voie d’affectation. Un administrateur peut
affecter directement une personne sans passer par lui, via l’édition standard de
l’événement (`PUT /api/planning/events/[eventType]/[eventId]`, champs `encadrants` /
`arbitreTouche` / `contactEncadrants` / `contactAccompagnateur`) ou via l’ajout manuel à la
liste d’attente (`POST /api/planning/waitlist`). Ces parcours restent soumis aux mêmes
contrôles de validation (`assignmentValidation`) que toute affectation.
