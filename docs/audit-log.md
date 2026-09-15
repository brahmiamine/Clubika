# Journaux d’audit minimisés

Issue de référence : [#20](https://github.com/brahmiamine/Clubika/issues/20)
(coordination : [#8](https://github.com/brahmiamine/Clubika/issues/8) rapports,
[#9](https://github.com/brahmiamine/Clubika/issues/9) rétention,
[#11](https://github.com/brahmiamine/Clubika/issues/11) fermeture de compte).

## Catalogue

Le catalogue versionné vit dans [`app/lib/audit/catalog.ts`](../app/lib/audit/catalog.ts)
(`AUDIT_CATALOG_VERSION = 1`). Il liste, action par action, les seuls champs
techniques autorisés dans `before` / `after` : identifiants, statuts, horodatages,
compteurs, `sourceOverride.changedFields`. Sont exclus noms, e-mails, téléphones,
textes de rapport/commentaire/message, motifs de refus, `rawText`, noms de fichiers,
jetons, secrets et URL signées.

Toute écriture passe par `logAuditEntry` → `minimizeAuditPayload`. Un appelant qui
fournit un snapshot métier complet ne peut pas contourner la rédaction centrale.

L’acteur est réduit à `userId`. Le libellé exposé est `Utilisateur #<id>` ou
`Système`. Les colonnes `userEmail` / `userNom` restent en base (créées par la
migration 0018, non modifiable) mais ne sont plus jamais renseignées.

## Lecture admin

`GET /api/matches/[id]/audit-log` et le dashboard club exposent le DTO
`toAuditLogDto` : même minimisation, isolation par `clubId`, jamais d’e-mail ni de
nom. L’historique lisible (`humanizeAuditEntry`) utilise le même libellé
pseudonymisé.

## Migration 0037 `assainir_journaux_audit`

`up()` :

1. inventaire dry-run (décompte scanned / actorCleared / payloadRedacted / mutated) ;
2. application : NULL des colonnes d’acteur nominatif, réécriture minimisée des
   JSON `before`/`after`.

Idempotente. Pas de table miroir nominative (cela recopierait des données
personnelles). Sauvegarde : snapshot SQL de l’instance **avant** `db:migrate`.
Retour arrière : restaurer ce snapshot. La suite de tests rejoue ce cycle sur des
lignes synthétiques uniquement.

## Risque résiduel

- Un prénom isolé stocké par erreur dans une clé technique (`status`, `id`) n’est
  pas un motif de téléphone ni un e-mail : il pourrait passer le filtre de jetons.
  Les clés nominatives connues sont dénylistées ; le catalogue n’accepte pas les
  clés inconnues.
- La suppression d’un objet n’écrit plus son contenu personnel dans l’audit
  (minimisation à l’écriture + purge 0037). Les corps de chat et rapports métier
  restent dans leurs tables jusqu’aux politiques #9 / #11 / #12.
- Revue humaine sécurité/RGPD avant fusion en production.
