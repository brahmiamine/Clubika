# Commande — Audit Base de données et API

Réalise un **audit complet et approfondi de la base de données, du modèle de données et de toutes les API** du projet **Clubika** à partir du code réel présent sur `main`.

Repository : `https://github.com/brahmiamine/Clubika`

Stack de référence à confirmer dans le code : TypeORM + MariaDB. Si `/audits/00-global-cartography.md` existe, réutilise l'inventaire des entités/API comme base, mais revérifie chaque contrainte/relation directement dans les fichiers d'entités et les migrations.

## Objectif

Vérifier la cohérence complète : frontend → API → validation → règles métier → services/repositories → ORM → DB.

Détecte : modèles incohérents, relations incorrectes, FK/UNIQUE/index manquants, données orphelines, migrations incohérentes, colonnes/enums legacy, endpoints inutilisés, validations absentes, transactions manquantes, race conditions, N+1, sur-fetching, mauvaise pagination, erreurs mal gérées et requêtes non scopées par tenant.

## Architecture Data/API

Cartographie ORM (TypeORM), datasource, connexion DB (MariaDB), entités, repositories, services, migrations, seeds, scripts DB (`scripts/**`, `db:migrate`), API Routes, validation, transactions, pagination et sérialisation.

## Modèle de données

Recense toutes les entités réelles. Pour chacune : table, PK, tenant/ownership, relations, nullabilité, defaults, enums, soft delete et indexes.

Construis un diagramme ER Mermaid `erDiagram` de haut niveau.

## Ownership et Multi-Tenant

Pour chaque entité importante, identifie le chemin vers le club/tenant. Vérifie que les requêtes tenant-scoped utilisent toujours le tenant courant ou un ownership vérifié.

Recherche les patterns dangereux : `findOne({id})`, `delete(id)`, `update(id, data)` sans filtre tenant lorsque nécessaire. Tout pattern trouvé constitue un candidat de finding croisé avec l'audit sécurité (`02`) — signale-le explicitement.

## Relations et intégrité

Analyse toutes les relations OneToOne/OneToMany/ManyToOne/ManyToMany : FK, nullable, cascade, onDelete/onUpdate, inverse relation et risques de suppression historique.

Recherche les relations logiques reposant uniquement sur des IDs sans FK lorsqu'une contrainte DB est nécessaire.

## Unicité

Analyse les contraintes UNIQUE autour des emails, memberships, affectations, matchs scrapés, conversations privées, invitations, PushSubscriptions et toute autre ressource sensible.

Vérifie les race conditions `find -> check -> insert` sans contrainte DB.

## Index et performance

Analyse les requêtes fréquentes et les indexes simples/composites, notamment sur clubId, userId, eventId, conversationId, status, date, createdAt, published, externalId, unread.

Ne recommande un index qu'avec justification concrète (requête réelle identifiée dans le code, volumétrie attendue).

## Enums, nullabilité et legacy

Recense les enums TypeScript/DB et détecte les valeurs dupliquées ou historiques. Vérifie si des champs fonctionnellement obligatoires sont nullable et si defaults DB/application divergent.

## Dates et timezone

Analyse createdAt/updatedAt, dates de match, publishedAt, readAt, deletedAt, expiration invitation, indisponibilités. Vérifie UTC/local/date-only/timestamp et risques de décalage Europe/Paris (changement heure été/hiver notamment).

## Suppressions et historique

Distingue hard delete, soft delete, désactivation et archive. Analyse les conséquences sur clubs, users, events, assignments, conversations, notifications et historique des anciens plannings.

## Migrations

Analyse toutes les migrations dans l'ordre et vérifie que l'état final obtenu correspond aux entités actuelles.

Recherche : colonnes entité sans migration, colonnes DB devenues inutiles, migrations destructrices, renommages incomplets, `synchronize: true` dangereux en production, seeds inadaptés à la production.

Lorsque l'environnement le permet, exécute réellement les migrations sur une base vide (`pnpm run db:migrate` ou équivalent contre une DB de test/CI, jamais contre une base de production) et confirme que le schéma obtenu correspond aux entités. Sinon, marque `Non exécuté — vérification statique uniquement`.

## Transactions et concurrence

Recense les opérations multi-étapes : invitation, affectation, publication, scraping, création conversation, mark-all-read, batch operations.

Vérifie atomicité, succès partiels, transactions trop larges, appels externes (HTTP) exécutés à l'intérieur de transactions DB, race conditions et besoin éventuel de locking/versioning.

## Inventaire API exhaustif

Parcours `app/api/**/route.ts` dans son intégralité et construis un tableau endpoint/méthode/domaine/auth/permission/validation/DB/réponse.

Analyse conventions HTTP, 200/201/204/400/401/403/404/409/422/500 et distinction 401 vs 403.

## Validation

Vérifie body, params, query, IDs, enums et champs sensibles côté serveur. Une validation frontend ne suffit pas.

Recherche mass assignment et propriétés sensibles modifiables accidentellement.

## Contrats et sérialisation

Vérifie si des entités ORM complètes sont renvoyées directement (risque de fuite de champs sensibles : mots de passe hashés, tokens, données d'un autre tenant présentes dans une relation chargée) et si des champs sensibles ou inutiles peuvent fuiter.

Recherche divergence de types entre frontend et API, over-fetching, under-fetching et endpoints legacy.

## Pagination, filtres et tri

Analyse listes d'événements, messages, notifications, archives, utilisateurs et autres collections. Vérifie limites, tri stable, cursor/offset, filtres tenant-scoped et paramètres de tri sûrs (pas d'injection via un paramètre `sort`/`orderBy` non validé).

## N+1 et requêtes coûteuses

Recherche requêtes dans boucles, relations chargées inutilement (`relations: [...]` larges), SELECT trop larges et écrans nécessitant trop d'appels API.

## Gestion des erreurs

Analyse violations UNIQUE/FK, timeout, deadlock, catch silencieux, exposition d'`error.message` DB/ORM au client et réponses incohérentes.

## API inutilisées / code mort

Recherche les consommateurs frontend de chaque endpoint et classe les API : utilisées, probablement utilisées, aucun consommateur trouvé. Ne supprime rien pendant l'audit.

## Tests

Recense les tests DB/API : FK, UNIQUE, transactions, migrations, auth, permissions, cross-tenant, validation, erreurs, idempotence.

Analyse si une DB vide peut être reconstruite par migrations en CI (vérifie le job correspondant dans `.github/workflows/**`).

## Cas obligatoires

Analyse ou teste : deux créations simultanées, suppression parent/enfants, user supprimé avec historique, club désactivé, match supprimé avec affectations, conversation avec participant supprimé, body invalide, ID inexistant, non-authentifié, mauvais rôle, ressource autre tenant, double requête identique.

## Findings

Utilise `DB-001...` et `API-001...`.

Pour chaque finding : priorité, statut de preuve, observation, fichier/fonction/endpoint, impact, scénario et correction recommandée.

P0 : corruption/fuite cross-tenant/migration destructrice ; P1 : contraintes ou transactions critiques incorrectes ; P2 : N+1, index, pagination, contrat incohérent ; P3 : nettoyage/convention/legacy.

## Score

Donne une note `/100` avec pondération explicite, par exemple : intégrité du modèle (20), isolation multi-tenant des requêtes (20), contrats API et validation (15), transactions/concurrence (15), migrations (10), performance N+1/index (10), gestion des erreurs (5), tests (5).

## Rapport

Crée ou remplace :

`/audits/06-database-api.md`

Inclure : sommaire, architecture Data/API, ER diagram, ownership, relations, contraintes, indexes, enums, suppressions, migrations, transactions, inventaire API complet, validation, contrats HTTP, pagination, performance, erreurs, legacy, tests, findings, décisions techniques, score détaillé et plan de remédiation.

## Definition of Done

- [ ] toutes les entités TypeORM apparaissent dans le diagramme ER avec leur chemin d'ownership ;
- [ ] tous les endpoints `app/api/**/route.ts` apparaissent dans l'inventaire API ;
- [ ] chaque migration est listée dans l'ordre avec son effet sur le schéma ;
- [ ] chaque pattern `findOne/delete/update(id)` sans filtre tenant trouvé est documenté avec sa preuve.

## Contraintes

- ne modifie ni entities, repositories, API, migrations, schema DB, package.json, CI ni tests produit ;
- ne crée ni issue ni PR ;
- seuls `/audits/**` peuvent être modifiés.

## Fin de tâche

Présente score `/100`, P0/P1/P2/P3, problèmes d'intégrité et multi-tenant en premier, 10 problèmes majeurs, causes racines, décisions techniques et plan de remédiation.

Arrête-toi après cet audit.
