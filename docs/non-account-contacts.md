# Fiches sans compte

Issue : [#26](https://github.com/brahmiamine/Clubika/issues/26).
Dépendances non empilées : [#9](https://github.com/brahmiamine/Clubika/issues/9) (purge),
[#12](https://github.com/brahmiamine/Clubika/issues/12) (textes / rôles),
[#22](https://github.com/brahmiamine/Clubika/issues/22) (workflow droits des comptes).

Les délais et textes affichés dans le produit sont des paramètres configurés par
le club. Ils ne constituent **pas** un avis juridique ni une obligation légale
calculée par l’application.

## Constat

Les référentiels (officiels, encadrants, accompagnateurs) créent des profils
`users` avec `claimedAt = null`, parfois un téléphone, sans compte. Ce sont des
données personnelles : il faut une provenance, une notice, un canal de droits et
un masquage du téléphone.

## Cycle de vie

| Étape | Comportement |
|---|---|
| Création | Nom autorisé sans provenance. **Téléphone interdit** tant que la provenance n’est pas choisie dans le catalogue fermé. |
| Provenance | Enum : `responsable_club`, `liste_competition`, `declaration_concernee`, `import_csv`. Aucun champ libre de « base légale ». |
| Finalité | Enum club : `organisation_planning`, `contact_operationnel`. |
| Notice | Version + texte saisis par le club / DPO (`club_notice_config`). Preuve limitée à version, canal, date, résultat. Sans version configurée, le résultat reste `pending`. |
| Invitation | Premier contact : preuve canal `invitation`. Le lien d’inscription affiche le texte de notice s’il existe, sans exposer d’autres membres. |
| Droits | Page publique `/droits-sans-compte` + `POST /api/public/non-account-rights`. Stockage d’empreintes SHA-256 uniquement. File admin `/club/fiches-sans-compte`. |
| Téléphone | Facultatif, masqué sur `GET /api/users` (sauf `?revealPhone=1`). Le référentiel admin conserve la valeur pour l’affectation / WhatsApp. |
| Opposition | Efface le téléphone, statut `refused`. |
| Effacement | Suppression si la fiche n’est pas référencée ; sinon anonymisation `fiche-{id}`. |
| Purge | Les statuts `unused` / `refused` / `orphan` existent. La purge planifiée réelle reste **#9**. |

## Import CSV

`POST /api/non-account-contacts/import`

Colonnes : `nom`, `provenance`, `category` (obligatoires), `telephone`, `purpose`
(optionnelles). Une provenance absente refuse la ligne. Le rapport renvoie
`{ accepted, refused: [{ line, error }] }` **sans recopier nom, email ni téléphone**.

## Migration

`0040` `fiches_sans_compte` : `non_account_contact_meta`, `club_notice_config`,
`non_account_rights_requests`. Idempotente (`CREATE TABLE IF NOT EXISTS`).

## Risque résiduel

- Les textes de notice et les délais légaux relèvent d’une revue club / DPO / conseil (**#12**, **#40**).
- Le workflow complet des comptes (export, limitation, opposition documentée) est **#22**.
- La purge automatique des fiches orphelines est **#9**.
