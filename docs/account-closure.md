# Fermeture et anonymisation de compte

Issue de référence : [#11](https://github.com/brahmiamine/Clubika/issues/11).
Durées d’effacement des contenus conservés : [#9](https://github.com/brahmiamine/Clubika/issues/9)
(non empilée ici). Jeton iCal : révocation immédiate ; rotation/capacité plus large = [#13](https://github.com/brahmiamine/Clubika/issues/13).

## Comportement

`DELETE /api/users/[id]` ne refuse plus un compte référencé (plus de 409 « désactivez-le »).
Le compte est **fermé en place** : l’identité nominative disparaît, un stub technique
reste pour les clés étrangères.

| Donnée | Traitement |
|---|---|
| Nom | remplacé par `Utilisateur supprimé` (brouillons, publication, historique, records, chat, transferts) |
| E-mail, téléphone, hash mot de passe, indisponibilités, préférences | supprimés |
| Sessions, jeton iCal, invitations en attente, jetons de reset, push | révoqués immédiatement |
| Ligne `users` | conservée (stub, `active = false`, `closedAt` renseigné) |
| Corps des messages de chat | conservés pour les autres participants ; seuls les noms d’affichage changent |
| Textes de commentaires / rapports / échanges | conservés, nom d’auteur anonymisé |

Aucune archive nominative n’est créée : il n’existe pas, à ce stade, de base légale
documentée pour conserver l’identité après fermeture. La table `account_closures`
ne contient qu’un agrégat (club, identifiant opaque du stub, rôles, catégories
conservées et justifications produit).

## Demande utilisateur et traitement admin

- `GET /api/me/account-closure` : aperçu sans écriture (dry-run logique).
- `POST /api/me/account-closure` sans `confirm` : enregistre `closureRequestedAt` et
  notifie les administrateurs.
- `POST /api/me/account-closure` avec `{ "confirm": true }` : ferme immédiatement
  le compte du demandeur (sauf dernier administrateur).
- `DELETE /api/users/[id]` : traitement administrateur, même moteur.
- `DELETE /api/users/[id]?dryRun=true` : aperçu sans écriture.

Le dernier administrateur actif doit transférer le rôle avant fermeture (HTTP 400).

L’opération est idempotente : un second appel renvoie le stub déjà fermé.

## Messages dont le contenu peut identifier quelqu’un

Choix produit de cette PR, **soumis à revue juridique (#12)** :

- les noms d’affichage (expéditeur, transfert) sont remplacés ;
- le corps n’est pas réécrit ni purgé à la fermeture, parce qu’il appartient aussi
  à la conversation des autres participants ;
- la durée d’effacement de ces corps est la politique produit globale (#9), pas une
  obligation légale inventée ici.

## Procédure opérateur

1. Dry-run : `DELETE /api/users/<id>?dryRun=true` (session admin) et lire `closure.preview`.
2. Fermeture réelle : `DELETE /api/users/<id>`.
3. Vérifier que le stub apparaît comme « Fermé » dans `/club/utilisateurs` et que
   l’e-mail technique `closed.<id>@invalid.local` n’est pas affiché.

Ne jamais lancer cette opération sur une base de production contenant des données
réelles depuis une pull request. Les tests n’utilisent que des fixtures synthétiques.

## Migration 0036 `fermeture_compte_utilisateur`

- Dry-run : relire le SQL (colonnes nullables + `CREATE TABLE IF NOT EXISTS`) ;
  aucune donnée existante n’est réécrite.
- Application : `pnpm run db:migrate` (ou démarrage applicatif).
- Retour arrière : `ALTER TABLE users DROP COLUMN closedByUserId, DROP COLUMN closureRequestedAt, DROP COLUMN closedAt;`
  puis `DROP TABLE account_closures;` et suppression de la ligne `0036` dans
  `schema_migrations` **uniquement si la migration n’a pas été fusionnée**.
- Impact : DDL court, pas de backfill nominatif.

## Points soumis à validation humaine / juridique

- Conservation des corps de messages et textes opérationnels jusqu’à #9.
- Absence d’archive nominative à échéance (pas de base légale inventée).
- Traitement des contenus encore identifiants par eux-mêmes (#12).
- Revue de sécurité avant fusion / production (suivre #19).
