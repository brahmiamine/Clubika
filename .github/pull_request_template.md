<!--
  Merci de remplir ce template avant de demander une revue. Il sert deux
  objectifs : donner aux reviewers le contexte fonctionnel, et forcer une revue
  privacy explicite dès qu'une frontière publique, un export ou un champ de
  fixture change (issue #41).
-->

## Résumé

<!-- Que fait cette PR, en une ou deux phrases ? Quel ticket ferme-t-elle ? -->

Closes #

## Checklist données personnelles (obligatoire)

Répondre à chaque ligne. « N/A » est une réponse valide si justifiée — ne pas
laisser une case vide.

- [ ] **Données** : quelles données à caractère personnel cette PR ajoute,
      modifie ou expose (nouveau champ, nouvelle route, nouveau log,
      nouvelle fixture/snapshot) ? Lister les champs concernés, ou indiquer
      « aucune ».
- [ ] **Finalité** : pour quelle finalité opérationnelle ces données sont-elles
      traitées ? (Pas de collecte « au cas où ».)
- [ ] **Durée de conservation** : combien de temps ces données sont-elles
      gardées ? Si une nouvelle catégorie de données est introduite, a-t-elle
      été ajoutée à `app/lib/retention/policy.ts` (issue #9) ?
- [ ] **Destinataires** : qui peut lire ces données (rôle club, admin
      plateforme, tiers/prestataire, public anonyme via une frontière
      publique) ?
- [ ] **Droits** : cette PR affecte-t-elle l'accès, la rectification,
      l'opposition, la portabilité ou l'effacement (RGPD) ? Si oui, comment
      est-ce couvert par `app/lib/privacy/` ?
- [ ] **Migration** : y a-t-il une migration de schéma ou de données ? Si oui,
      lien vers le fichier de migration et confirmation qu'elle ne recopie pas
      une donnée personnelle vers un nouvel endroit sans base légale.
- [ ] **Tests** : les tests utilisent-ils exclusivement des données sentinelles
      fictives (`app/lib/privacy-invariants/sentinel-factory.ts` : domaines
      `.test`/`.invalid`/`.example`, numéros `0600000000`/`0699000000`, jamais
      un nom/e-mail/numéro plausible) ? `pnpm run privacy:fixtures` passe en
      local sur le diff de cette branche ?

## Frontière publique / schéma exposé

- [ ] Cette PR ajoute-t-elle un champ à un DTO public, un export, une
      notification, un payload push, ou tout autre schéma déjà couvert par la
      matrice de frontières (`app/lib/privacy-invariants/boundaries.test.ts`) ?
      Si oui : **revue privacy explicite obligatoire** avant merge, et mise à
      jour de la copie figée dans
      `app/lib/privacy-invariants/public-schema-allowlist.test.ts`
      (ce test échoue volontairement tant que ce n'est pas fait).

## Tests

- [ ] `pnpm lint`
- [ ] `pnpm type-check`
- [ ] `pnpm test` (inclut la suite `app/lib/privacy-invariants/`)
- [ ] `pnpm run privacy:fixtures`
- [ ] `pnpm build` si le changement touche le build/déploiement

## Risques résiduels / points d'attention pour la revue

<!-- Ce qui n'est pas couvert par les tests, une hypothèse à valider, un suivi à ouvrir. -->
