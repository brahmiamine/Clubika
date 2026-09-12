# Commande — Audit fonctionnel et règles métier

Réalise un **audit fonctionnel complet et approfondi des règles métier** du projet **Clubika** à partir du code réel présent sur `main`.

Repository : `https://github.com/brahmiamine/Clubika`

Si `/audits/00-global-cartography.md` existe, utilise-le comme point de départ pour la cartographie des routes/API/entités, mais revérifie dans le code toute règle métier avant de la considérer comme acquise : cet audit doit être auto-suffisant et ne pas se contenter de recopier `00`.

## Objectif

Détecter toutes les incohérences fonctionnelles : workflows incomplets, règles métier contradictoires, états impossibles, différences frontend/API/DB, permissions incohérentes, règles dupliquées, cas limites non gérés et fonctionnalités partiellement implémentées.

Ne corrige rien pendant l'audit. Toute conclusion doit être prouvée dans le code, avec référence `fichier:ligne`.

## Domaines à analyser

Analyse au minimum : plateforme/Superadmin, clubs, utilisateurs, rôles, fonctions sur les matchs, événements, matchs, SportCorico, planning, affectations, publication, archives, indisponibilités, demandes de disponibilité, invitations, notifications, chat, profil, configuration et exports.

## Rôles et fonctions

Vérifie précisément la séparation entre :

- rôle d'accès au club, notamment `administrateur` et `dirigeant` ;
- fonction exercée sur un match, notamment arbitre club, encadrant et accompagnateur.

Recherche les anciens rôles ou valeurs legacy dans enums, DB, migrations, API, composants, tests et fixtures.

Construis une matrice des permissions réelles et compare UI/API. Signale les cas où l'UI masque une action mais l'API l'autorise, ou l'inverse. Toute divergence UI/API constitue un candidat direct de finding pour l'audit sécurité (`02`) — signale-le explicitement pour permettre la corrélation.

## Workflows obligatoires

Reconstitue et vérifie de bout en bout, avec diagramme Mermaid `sequenceDiagram` ou `stateDiagram` lorsque pertinent :

1. Création et configuration d'un club.
2. Invitation, inscription, rattachement et gestion d'un utilisateur.
3. Scraping SportCorico et impact fonctionnel sur les matchs.
4. Création manuelle d'un match et coexistence avec un match scrapé.
5. Préparation des matchs.
6. Affectation arbitre/encadrant/accompagnateur.
7. Contrôle des indisponibilités et conflits.
8. Publication du planning.
9. Visibilité dans `/mon-planning/**`.
10. Modification après publication.
11. Annulation, report, disparition et archivage.
12. Chat privé et discussions d'événement.
13. Notifications liées aux actions métier.

## Publication

Analyse en particulier les conditions réelles de publication. Vérifie si des règles du type :

- au moins 1 arbitre club ;
- au moins 1 encadrant ;
- au moins 1 accompagnateur ;

existent réellement, où elles sont appliquées (UI, API, service), si elles sont configurables, si elles dépendent du type de match et si elles sont protégées côté serveur (rejouable par un appel API direct, sans passer par l'UI).

Ne considère aucune règle comme valide sans preuve.

## Cas limites

Recherche activement, et pour chacun indique si le code le gère, l'ignore silencieusement, ou lève une erreur explicite : double clic, double publication, deux admins simultanés, utilisateur supprimé pendant une affectation, changement de rôle, indisponibilité déclarée après affectation, scraping pendant modification, match disparu puis revenu, invitation réutilisée, doublons, notifications envoyées au mauvais moment, modification après publication.

## Méthode

Pour chaque domaine :

- identifie routes frontend ;
- identifie endpoints API ;
- identifie services/helpers ;
- identifie tables/entités ;
- reconstruis les règles réellement appliquées ;
- compare frontend, backend et DB ;
- teste dynamiquement lorsque l'environnement local le permet (`pnpm test`, `pnpm test:coverage`, scénarios ciblés) et cite la commande exécutée et son résultat ;
- sinon écris explicitement `Audit statique uniquement — non vérifié dynamiquement`.

## Findings

Utilise les IDs :

`FUNC-001`, `FUNC-002`, etc.

Pour chaque finding, documente : priorité, domaine, observation, preuve (`fichier:ligne`), impact, cause probable, correction recommandée, et statut de preuve (`🔴 Confirmé` / `🟠 Très probable` / `🟡 À vérifier dynamiquement` / `⚪ Décision produit`).

Classe :

- P0 : bloquant / perte de données / workflow principal impossible ;
- P1 : règle métier importante incorrecte ;
- P2 : workflow incomplet ou cas limite ;
- P3 : dette mineure / terminologie / simplification.

Distingue toujours :

- fait observé ;
- règle métier attendue lorsqu'elle est prouvée ;
- risque ;
- recommandation.

Si la règle attendue n'est pas déterminable, écris `Décision produit nécessaire` et propose 2 à 3 options tranchables avec leurs implications, pour faciliter l'arbitrage produit sans bloquer l'audit.

## Causes racines

Regroupe les problèmes ayant une même origine. Ne crée pas une longue liste de symptômes si une cause unique explique plusieurs anomalies. Indique le nombre de findings rattachés à chaque cause racine.

## Score

Donne une note fonctionnelle `/100` avec une pondération explicite, par exemple : cohérence des workflows (20), règles métier de publication (20), rôles/permissions (15), cycle des matchs/affectations (15), indisponibilités/conflits (10), notifications/chat (10), utilisateurs/invitations (5), archives (5). Justifie tout écart significatif par rapport à 100 avec les findings correspondants.

## Rapport

Après analyse complète, crée ou remplace :

`/audits/01-functional-business-rules.md`

Le fichier doit contenir : sommaire, résumé exécutif, cartographie fonctionnelle, matrices, workflows (diagrammes), findings P0/P1/P2/P3, décisions produit avec options, causes racines, score détaillé par pondération et plan de remédiation priorisé (quick wins vs structurel).

## Definition of Done

- [ ] chaque workflow listé en « Workflows obligatoires » est reconstitué avec au moins une référence de code par étape ;
- [ ] la matrice UI/API de permissions couvre tous les rôles et fonctions identifiés ;
- [ ] chaque « Décision produit nécessaire » propose des options concrètes, pas seulement un constat ;
- [ ] le score est justifié poste par poste, pas donné en bloc.

## Contraintes

Pendant cet audit :

- ne modifie pas `app/**` ;
- ne change pas les règles métier ;
- ne modifie ni DB, ni API, ni migrations ;
- ne crée pas d'issue ;
- ne crée pas de PR de correction ;
- seuls les fichiers `/audits/**` peuvent être modifiés.

## Fin de tâche

Présente uniquement : score `/100`, nombre de P0/P1/P2/P3, 10 problèmes principaux, causes racines, décisions produit nécessaires, plan de remédiation et fichiers d'audit modifiés.

Arrête-toi après cet audit.
