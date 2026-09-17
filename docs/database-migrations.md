# Migrations de schéma base de données

Issues de référence : [#129](https://github.com/brahmiamine/Clubika/issues/129),
[#283](https://github.com/brahmiamine/Clubika/issues/283).

## Principe

Toute évolution du schéma passe par une **migration versionnée** — jamais par un
`CREATE TABLE IF NOT EXISTS` exécuté au premier appel d'un module métier, et jamais
par TypeORM `synchronize()` au démarrage en production.

- Le registre ordonné des migrations vit dans
  [`app/lib/db/migrations/schema-migrations.ts`](../app/lib/db/migrations/schema-migrations.ts).
- Le runner ([`app/lib/db/migrations/runner.ts`](../app/lib/db/migrations/runner.ts))
  journalise chaque migration appliquée dans la table `schema_migrations`
  (version, nom, empreinte SHA-256, date).
- L'empreinte couvre la version, le nom, les instructions SQL **et** le contenu
  des fichiers source de `up()` (`logic`, lu depuis le disque — pas
  `Function#toString()`, instable entre tsx et Vitest). Modifier ces fichiers après
  application bloque le boot. Les bases journalisées avant cette couverture voient
  leur empreinte réécrite une seule fois (statements-only → statements + logique),
  sans rejouer le DDL.
- Les migrations sont appliquées automatiquement à l'initialisation de la connexion
  (`getDataSource()`), donc avant toute requête applicative. Un échec est
  **bloquant** : l'application refuse de démarrer sur un schéma incohérent.
- Un verrou consultatif MariaDB (`GET_LOCK`) empêche deux instances d'exécuter le
  DDL simultanément au démarrage.
- Les tables d'entités TypeORM (`EntitySchema` dans `app/lib/db/schemas.ts`) sont
  créées par la migration `0018`. `synchronize()` n'est **jamais** appelé lorsque
  `NODE_ENV=production`. Hors production, un opt-in explicite
  `TYPEORM_SYNCHRONIZE=1` reste disponible pour un bac local — ce n'est pas le
  chemin par défaut, ni celui de la CI.

## Règles d'écriture d'une migration

1. Nouvelle migration = nouvelle entrée en fin de registre, version sur 4 chiffres
   strictement croissante (`0008`, `0009`, …).
2. **Immuabilité** : ne jamais modifier une migration déjà fusionnée sur `main` —
   l'empreinte (SQL + `up()`) est revérifiée à chaque démarrage et toute divergence
   bloque le boot.
3. **Idempotence** : chaque instruction doit pouvoir être rejouée sans erreur
   (`IF NOT EXISTS`, `INSERT IGNORE`, …) car MariaDB ne transactionne pas le DDL.
4. La logique dépendant de l'existant (backfills) va dans `up(db)` et doit être
   elle aussi idempotente.
5. Toute évolution d'une entité TypeORM (colonne, index, table) ajoute une nouvelle
   migration — ne pas réactiver `synchronize` au boot.

## Exploitation

### Commande

```bash
pnpm run db:migrate
```

Applique les migrations manquantes puis affiche le journal. Variables d'environnement
habituelles : `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.

### Ordre de déploiement

```
build → db:migrate → start
```

En pratique le démarrage applicatif rejoue le runner (sans effet si tout est déjà
appliqué, et **sans** `synchronize` en production), donc un oubli de l'étape
explicite ne laisse pas le schéma à la traîne — mais l'étape `db:migrate` permet de
faire échouer le déploiement **avant** la mise en service.

La migration `0038` (issue #22) crée les tables d’exercice des droits et ajoute
les drapeaux de restriction/opposition sur `users`. Idempotente.

La migration `0037` (issue #20) n'ajoute pas de colonne : elle inventorie puis
assainit les lignes de `match_audit_log` (voir [`docs/audit-log.md`](audit-log.md)).
Prendre une sauvegarde SQL avant `db:migrate` sur une instance qui contient déjà
de l'audit ; le retour arrière est la restauration de cette sauvegarde.

### CI

Le job `test` de `.github/workflows/ci.yml` exécute `pnpm run db:migrate` contre une
MariaDB vierge avant `pnpm run test`, **sans** `TYPEORM_SYNCHRONIZE`. La suite
contient des tests d'intégration du runner (`app/lib/db/migrations/runner.test.ts`) :
base vierge, réexécution idempotente, immuabilité de SQL et de `up()`, détection de
dérive, présence des tables d'entités après migrations seules.

### Docker / local

En local, `start.sh` et `pnpm dev` déclenchent les migrations au premier accès DB.
Avec Docker Compose, ajouter un service one-shot `migrate` (même image, commande
`pnpm run db:migrate`) dont le service applicatif dépend (`depends_on` +
`condition: service_completed_successfully`).

`TYPEORM_SYNCHRONIZE=1` n'est utile que pour un bac de développement hors CI, jamais
en production (`NODE_ENV=production` l'ignore).

La migration `0039` (issue #25) ajoute l’état d’offboarding sur `club_tenants` et
les tables de restitution / instructions sous-traitants / certificats. Idempotente.
Voir [tenant-offboarding.md](./tenant-offboarding.md).

La migration `0041` (issue #27) réduit `planning_notification_outbox` au strict
nécessaire pour livrer et rejouer un envoi : ajout de `template_id` (gabarit
allowlisté par canal) et `notification_id` (identifiant opaque vers la notification
in-app, seule source du détail réel), puis suppression de `notification_type`,
`title`, `message`, `event_type`, `event_id` et `urgency`. Idempotente ; sur une base
déjà en production, prendre une sauvegarde SQL avant `db:migrate` (les colonnes
supprimées ne sont pas récupérables). Voir aussi le code applicatif dans
`app/lib/notifications/outbox.ts`, `app/lib/notifications/templates.ts` et
`app/api/notifications/[id]/open/route.ts`.

### Rollback

Les migrations sont à sens unique et sans `down` automatisé. Stratégie :

- erreur détectée avant mise en production : supprimer la ligne correspondante de
  `schema_migrations`, annuler manuellement le DDL, corriger la migration **tant
  qu'elle n'a pas été fusionnée** ;
- erreur détectée après fusion : écrire une nouvelle migration corrective, ne jamais
  réécrire l'historique.

## Inventaire du DDL migré (étape 1 de l'issue)

| Table | Ancien propriétaire runtime | Migration |
|---|---|---|
| `planning_records`, `planning_attachments` | `app/lib/planning/records.ts` | `0001` |
| `planning_event_state` | `app/lib/planning/event-lifecycle.ts` | `0002` |
| `push_subscriptions` | `app/lib/push/store.ts` | `0003` |
| `planning_notification_outbox` | `app/lib/notifications/outbox.ts` | `0004` |
| `chat_attachments` | `app/lib/chat/attachments.ts` | `0005` |
| `scraper_sync_runs` | `app/lib/scraper/runs.ts` | `0006` |
| `planning_assignment_state` | `app/lib/planning/assignment-state-store.ts` | `0007` |
| tables d'entités TypeORM (`users`, `clubs`, chat, …) | `DataSource.synchronize()` au boot | `0018` |
| `account_closures` + colonnes `users.closedAt` / `closureRequestedAt` / `closedByUserId` | fermeture de compte (issue #11) | `0036` |
| `non_account_contact_meta`, `club_notice_config`, `non_account_rights_requests` | cycle de vie des fiches sans compte (issue [#26](https://github.com/brahmiamine/Clubika/issues/26)) | `0040` |

## Conversions de schéma encadrées

| Table | Conversion | Migration |
|---|---|---|
| `matches_officiels`, `matches_amicaux`, `entrainements`, `plateaux` | `PRIMARY KEY (id)` → `PRIMARY KEY (clubId, id)` (issue [#125](https://github.com/brahmiamine/Clubika/issues/125)) | `0008` |
| `matches_extras` | `PRIMARY KEY (matchId)` → `PRIMARY KEY (clubId, matchId)` | `0008` |
| `match_audit_log` | Ajout du tenant `clubId` (nullable) puis remplissage, avant durcissement NOT NULL (issue [#126](https://github.com/brahmiamine/Clubika/issues/126)) | `0009` |

La migration `0008` ([`event-primary-keys.ts`](../app/lib/db/migrations/event-primary-keys.ts))
est conditionnelle : elle ignore une table absente (base neuve, créée ensuite par
`0018` directement avec la clé composite) ou déjà convertie, refuse toute
forme de clé inattendue, et **vérifie les collisions** (même clé métier dans deux
clubs) avant l'`ALTER TABLE`. Les anciens index `idx_*_club`, devenus redondants
(la colonne `clubId` est en tête de la clé primaire), ne sont plus recréés.

La migration `0009` ([`audit-log-tenant.ts`](../app/lib/db/migrations/audit-log-tenant.ts))
ajoute la colonne `clubId` **nullable** (une colonne NOT NULL ne peut pas être
créée sur une table existante remplie), la remplit par jointure sur `users`
(club de l'auteur de chaque écriture) puis rattache les lignes sans auteur
résolu (utilisateur supprimé, écritures système de l'ère mono-club) au club par
défaut `APP_CLUB_ID` — avec avertissement de comptage. La migration `0018` durcit
ensuite la colonne en NOT NULL et crée l'index tenant
`(clubId, entityType, entityId, createdAt)`. Sur une base neuve, la table est
absente au passage de `0009` : la migration n'a rien à remplir et `0018`
crée directement la colonne NOT NULL.

La migration `0027` ([`audit-sportcorico-data.ts`](../app/lib/db/migrations/audit-sportcorico-data.ts),
issue #5) inventorie les payloads SportCorico déjà stockés. Par défaut elle
n’écrit rien (dry-run, compteurs uniquement). La quarantaine réelle exige
`SPORTCORICO_DATA_PURGE=apply` et se lance avec `pnpm run sportcorico:quarantine`
après une sauvegarde — voir
[`docs/sportcorico-data-quarantine.md`](./sportcorico-data-quarantine.md).

Restent hors périmètre volontairement : les `ALTER TABLE` défensifs du
`json-migrator` (migration de données héritées JSON → SQL, bornée par marqueur et
vérifications `information_schema`). L'évolution courante des colonnes d'entités
passe par une nouvelle migration versionnée.
