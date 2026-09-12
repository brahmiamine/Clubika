# Commande — Audit global et cartographie

Analyse en profondeur le projet **Clubika** à partir du code réel présent sur `main`.

Repository : `https://github.com/brahmiamine/Clubika`

Stack de référence à valider dans le code (ne présume rien, vérifie) : Next.js (App Router), TypeScript, TypeORM, MariaDB, Socket.IO, Web Push/PWA, Vitest, Playwright, pnpm, GitHub Actions.

## Objectif

Construire une cartographie fiable, exhaustive et **exploitable en production** de l'application avant toute correction : architecture, routes, API, modèles de données, rôles, permissions, workflows, scraping, planning, notifications, chat, PWA, Design System, observabilité, exploitation, tests et CI/CD.

Ce document doit servir de référence unique (single source of truth) pour les 8 audits spécialisés qui en dépendent (`01` à `08`) : toute incohérence ou zone d'ombre laissée ici se propage aux audits suivants.

Ne te base pas uniquement sur le README ou les commentaires. Vérifie chaque affirmation directement dans le code exécuté (routes, requêtes DB, config CI). Si la documentation et le code se contredisent, considère le code actuel comme source de vérité et signale explicitement la contradiction avec les deux références.

## Méthode de preuve (obligatoire pour tous les audits)

- Toute affirmation structurante doit citer `chemin/fichier.ext:ligne` (ou plage de lignes) et le nom de la fonction/composant/endpoint concerné.
- Distingue toujours **fait observé dans le code**, **hypothèse à vérifier dynamiquement**, et **zone non déterminable statiquement**.
- Ne suppose jamais qu'une fonctionnalité existe parce qu'elle serait « logique » ou « habituelle » dans ce type d'application : si le code ne la montre pas, écris `Non trouvé dans le code`.
- Quand une vérification nécessite une exécution (build, requête DB réelle, rendu navigateur) et que l'environnement le permet, exécute-la réellement (`pnpm install`, `pnpm type-check`, `pnpm lint`, `pnpm test`, `pnpm build`) plutôt que de la simuler, et cite la commande + son résultat. Sinon, marque explicitement `Non vérifié dynamiquement — analyse statique uniquement`.

## Travail demandé

1. Analyse la structure complète du repository et identifie frontend, backend, App Router, composants client/server, API Routes, services, hooks, providers, middleware, utilitaires, ORM (entités TypeORM), DB, migrations, Socket.IO, PWA, scraping, exports, scripts d'exploitation (`scripts/**`), tests et CI/CD.
2. Recense récursivement toutes les routes `app/**/page.tsx` (et `layout.tsx` pertinents). Classe-les par espace : public/auth, `/club/**`, `/mon-planning/**`, `/plateforme/**` et toute autre route réelle. Indique pour chacune : protection (middleware/guard), rôle requis, données chargées côté serveur vs client.
3. Recense récursivement toutes les API `app/api/**/route.ts`. Pour chaque endpoint, indique méthode HTTP, responsabilité, authentification, rôle/permission, schéma de validation (le cas échéant), données principales, codes de réponse observés dans le code, et consommateurs frontend lorsque possible (recherche des appels `fetch`/hooks correspondants).
4. Cartographie les utilisateurs, rôles d'accès, fonctions sur les matchs et permissions. Distingue explicitement rôle d'accès au club et fonction exercée sur un événement. Vérifie la présence d'un éventuel rôle plateforme/Superadmin distinct du rôle club.
5. Cartographie toutes les entités DB (entités TypeORM), relations, clés étrangères, enums, statuts, contraintes, index, migrations et chemin d'ownership vers le club/tenant. Vérifie la cohérence entre entités TypeScript et migrations SQL réellement appliquées.
6. Construis la liste complète des fonctionnalités réellement implémentées, classées par domaine, avec un état (`complet`, `partiel`, `stub/non branché`).
7. Reconstitue les principaux workflows métier de bout en bout : création/configuration club, invitation/utilisateur, scraping SportCorico, préparation match, affectations, publication, Mon Planning, indisponibilités, chat, notifications, archives.
8. Documente l'architecture SportCorico : configuration, déclenchement (bouton/cron/API), parsing, matching club, matching match, création/mise à jour/disparition.
9. Reconstitue le cycle de vie réel des matchs/événements et leurs statuts (machine à états si observable).
10. Cartographie toutes les notifications et tous les flux de chat/Socket.IO (événements émis/reçus, rooms, authentification socket).
11. Documente l'architecture PWA : manifest, service worker, push, VAPID, subscriptions, mode standalone.
12. Cartographie le Design System existant : `app/globals.css`, `app/components/ui/**`, `app/components/layout/**`, primitives de page, navigation, tokens, thèmes et branding dynamique par club.
13. Recense les tests Unit/Component/API/Integration/E2E ainsi que les scripts npm (`package.json`) et workflows CI (`.github/workflows/**`). Pour chaque job CI : déclencheur, étapes, obligatoire ou non pour merger.
14. Documente l'exploitation/production actuelle telle qu'observable dans le code : variables d'environnement requises (`.env.example` ou équivalent), scripts de migration/seed, logs, gestion des erreurs globales, configuration MariaDB, secrets attendus, santé/health-check si présent, et tout élément de déploiement (Dockerfile, CI de déploiement).
15. Identifie les contradictions évidentes, éléments legacy, code mort probable, zones sensibles et sujets nécessitant un audit spécialisé — en indiquant vers quel audit (`01` à `08`) chaque zone à risque doit être approfondie.

## Référentiels à mobiliser (pour préparer les audits spécialisés, sans les traiter en profondeur ici)

- OWASP ASVS / OWASP Top 10 / OWASP API Security Top 10 (pour signaler les zones à approfondir en `02`).
- WCAG 2.2 niveau AA (pour signaler les zones à approfondir en `07`).
- RGPD/CNIL — données personnelles traitées (identité, coordonnées, disponibilités) et leur cycle de vie.
- Douze facteurs (12-factor app) pour la partie configuration/exploitation.

## Format attendu

Produis notamment :

- une vue d'architecture globale (avec un diagramme Mermaid `graph`/`flowchart`) ;
- un inventaire des routes (tableau) ;
- un inventaire des API (tableau) ;
- une matrice rôles/permissions ;
- un diagramme Mermaid `erDiagram` des entités et relations ;
- une cartographie des fonctionnalités avec statut d'implémentation ;
- des diagrammes Mermaid `sequenceDiagram` ou `stateDiagram` pour les workflows et cycles de vie importants ;
- une fiche « configuration & exploitation » (env vars, secrets attendus, migrations, seeds, santé) ;
- une liste des zones à risque, chacune orientée vers l'audit spécialisé pertinent ;
- les contradictions code/documentation ;
- les parties non vérifiables en exécution, clairement marquées.

Pour chaque affirmation importante, cite le fichier, la fonction/composant ou l'endpoint concerné. Ne suppose aucune fonctionnalité absente du code.

## Rapport

Après avoir terminé l'analyse, crée ou remplace :

`/audits/00-global-cartography.md`

Le rapport doit être suffisamment précis et structuré (sommaire en tête de document) pour permettre à un autre développeur — ou aux 8 audits spécialisés suivants — de comprendre l'application sans recommencer l'analyse.

## Definition of Done

L'audit n'est considéré complet que si :

- [ ] chaque route et chaque endpoint API du repository apparaît dans un inventaire ;
- [ ] chaque entité DB a un chemin d'ownership tenant documenté (ou une mention explicite d'absence) ;
- [ ] au moins un diagramme Mermaid par catégorie (architecture, ER, workflow) est présent et cohérent avec le code cité ;
- [ ] la section « zones à risque » relie explicitement chaque risque à l'audit `01`–`08` correspondant ;
- [ ] aucune affirmation structurante n'est dépourvue de référence `fichier:ligne`.

## Contraintes

Pendant cette tâche :

- ne corrige aucun bug ;
- ne refactore pas ;
- ne modifie ni UI, ni API, ni DB, ni migrations ;
- ne crée pas d'issue ;
- ne crée pas de PR de correction ;
- seuls les fichiers sous `/audits/**` peuvent être ajoutés ou modifiés.

## Fin de tâche

À la fin, présente :

- résumé de l'architecture ;
- principales zones à risque, avec renvoi vers l'audit spécialisé concerné ;
- contradictions importantes ;
- fichiers d'audit créés ou modifiés.

Arrête-toi après cet audit.
