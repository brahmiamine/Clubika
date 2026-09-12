# Commande — Audit sécurité et Multi-Tenant

Réalise un **audit complet de sécurité et d'isolation Multi-Tenant** du projet **Clubika** à partir du code réel présent sur `main`, au niveau d'exigence attendu avant une mise en production réelle exposée à Internet.

Repository : `https://github.com/brahmiamine/Clubika`

Si `/audits/00-global-cartography.md` existe, réutilise l'inventaire des routes/API/entités comme point de départ, mais revérifie toi-même chaque contrôle d'accès : ne fais confiance à aucun résumé précédent pour les affirmations de sécurité.

## Objectif principal

Je veux pouvoir répondre avec certitude à cette question :

> Un utilisateur du Club A peut-il lire, modifier, supprimer ou déclencher une action concernant le Club B ?

L'isolation doit être vérifiée côté serveur, jamais uniquement dans l'UI.

Analyse également la séparation entre utilisateur non authentifié, dirigeant, administrateur club, administration plateforme/Superadmin et éventuels rôles legacy.

## Référentiels à mobiliser explicitement

Pour chaque famille de findings, indique la correspondance avec au moins un de ces référentiels lorsque pertinent :

- OWASP Top 10 (2021) ;
- OWASP API Security Top 10 (2023) ;
- OWASP ASVS (niveau 2 minimum pour une application multi-tenant avec données personnelles) ;
- CWE pertinent (ex. CWE-639 IDOR, CWE-862 Missing Authorization, CWE-798 Hardcoded Credentials) ;
- RGPD/CNIL pour toute fuite ou traitement non maîtrisé de données personnelles (identité, coordonnées, disponibilités des utilisateurs).

## Architecture de sécurité

Cartographie : authentification, sessions/tokens, cookies, middleware, récupération de l'utilisateur courant, `accessRole`, club/tenant courant (y compris tout usage d'`AsyncLocalStorage` ou équivalent pour porter le contexte tenant), helpers d'autorisation, protections API, Socket.IO, Web Push, routes publiques, partage, uploads, exports et scraping.

Pour chaque ressource, identifie son chemin d'ownership vers le club/tenant.

## Audit API exhaustif

Parcours toutes les routes `app/api/**/route.ts` (inventaire complet, sans échantillonnage).

Pour chaque endpoint, documente : méthode, authentification, rôle, tenant check, ownership check et risque.

Teste ou vérifie conceptuellement les accès Cross-Tenant sur GET, POST, PATCH/PUT et DELETE.

Recherche activement, avec citation `fichier:ligne` pour chaque occurrence trouvée :

- IDOR / BOLA ;
- requêtes par `id` sans filtre tenant ;
- `clubId`, `userId`, `eventId`, `conversationId`, etc. acceptés depuis le body/query sans contrôle contre le tenant/l'utilisateur courant ;
- mass assignment (champs sensibles modifiables via un body non filtré, ex. `role`, `clubId`, `isAdmin`) ;
- élévation horizontale et verticale de privilèges ;
- règles protégées seulement côté UI ;
- BFLA (Broken Function Level Authorization) : endpoints d'administration accessibles sans vérification de rôle.

## Rôles et privilèges

Vérifie qu'un dirigeant ne peut pas appeler directement les actions admin et qu'un administrateur club ne peut pas obtenir de droits plateforme.

Teste notamment : rôle, configuration, publication, scraping, invitations, suppressions, exports et gestion utilisateurs.

## Authentification et sessions

Analyse login, logout, expiration, cookies, changement de mot de passe, reset password, invitation, utilisateur/club désactivé et anciennes sessions.

Vérifie notamment : `HttpOnly`, `Secure`, `SameSite`, algorithme et expiration des tokens/JWT le cas échéant, stockage des mots de passe (algorithme de hash, salage, coût), politique de tentatives (lockout/rate limit sur le login), invalidation à la déconnexion et éventuelle persistance d'anciens privilèges après changement de rôle.

## Entrées et vulnérabilités Web

Analyse selon l'architecture réelle, avec preuve pour chaque point traité :

- injection SQL/ORM (requêtes brutes, `query()` avec concaténation, paramètres non liés) ;
- XSS (échappement, `dangerouslySetInnerHTML`, rendu de contenu utilisateur dans le chat/notifications) ;
- CSRF (nécessité réelle vu le modèle d'authentification — cookies vs bearer) ;
- CORS (headers, origines autorisées) ;
- SSRF dans le scraping (contrôle de l'URL cible, redirections, hôtes internes) ;
- validation des inputs (bibliothèque de schéma utilisée ou absence) ;
- mass assignment ;
- rate limiting sur opérations sensibles (login, invitations, envoi de messages, déclenchement scraping, endpoints publics) ;
- fuite d'informations dans erreurs/logs (stack traces, messages ORM, données sensibles en clair dans les logs).

Ne crée pas de finding générique sans preuve concrète.

## Chat / Socket.IO

Vérifie authentification Socket.IO, rooms, conversation ownership, tenant scope, participants et payloads contrôlés par client.

Scénario critique : `User Club A -> room/conversation/event Club B` doit être impossible côté serveur.

## Notifications / Push

Vérifie ownership des notifications et PushSubscriptions.

Scénarios importants :

- User A ne peut pas lire/modifier la notification de User B ;
- un client ne peut pas enregistrer une subscription pour un autre utilisateur ;
- logout/changement de compte ne provoque pas de push vers le mauvais utilisateur.

## Données et exports

Vérifie que toutes les ressources sensibles sont tenant-scoped : événements, utilisateurs, affectations, indisponibilités, conversations, messages, notifications, configuration, archives, exports et autres entités réelles.

## Secrets et configuration

Recherche les secrets potentiellement committés ou exposés dans `.env*`, CI, code, tests et variables `NEXT_PUBLIC_*` (toute clé privée exposée côté client est un P0). Vérifie la gestion des clés VAPID, identifiants DB, secrets JWT/session et tout token de service (ex. cron/scraper).

Vérifie s'il existe une procédure ou au moins un mécanisme technique de rotation des secrets ; sinon, note-le comme recommandation de hardening (P2/P3, pas un blocant de sécurité applicative).

Ne recopie jamais une valeur sensible dans le rapport. Utilise `[REDACTED]`.

## Dépendances (SCA)

Lorsque l'environnement le permet, exécute une analyse de dépendances (`pnpm audit` ou équivalent) et cite les vulnérabilités critiques/hautes réellement exploitables dans le contexte de l'application (pas un simple copier-coller du rapport brut). Sinon, marque `Non exécuté — analyse SCA non réalisée`.

## Tests

Analyse les tests existants de sécurité et construis une matrice Cross-Tenant par ressource et méthode HTTP.

Lorsque l'environnement le permet, utilise des comptes de test Club A / Club B et réalise uniquement des tests non destructifs en environnement local/test.

Sinon marque `Non vérifié dynamiquement — preuve statique uniquement`.

## Findings

Utilise `SEC-001`, `SEC-002`, etc.

Pour chaque finding : sévérité, domaine, référentiel (OWASP/CWE), observation, preuve (fichier/fonction/endpoint), scénario, exploitabilité, impact et correction recommandée.

Ajoute un statut :

- 🔴 Confirmé ;
- 🟠 Très probable ;
- 🟡 À vérifier dynamiquement ;
- ⚪ Hardening.

Priorités :

- P0 : fuite/modification Cross-Tenant, élévation Superadmin, secret critique exposé ;
- P1 : endpoint sensible mal protégé, élévation de privilège ;
- P2 : défense en profondeur / validation / exposition limitée ;
- P3 : hardening mineur.

## Score

Donne une note sécurité `/100`, avec une pondération explicite, par exemple : isolation Multi-Tenant (30), authentification/sessions (15), autorisation/ownership API (20), Socket.IO/Chat (10), Web Push (5), secrets/configuration (10), dépendances (5), tests sécurité (5). Justifie tout écart par les findings correspondants.

## Rapport

Crée ou remplace :

`/audits/02-security-multitenancy.md`

Le rapport doit contenir : sommaire, résumé exécutif, architecture sécurité, modèle tenant, inventaire API complet, matrice permissions, findings, scénarios Cross-Tenant, auth, Socket.IO, push, secrets, résultats SCA, correspondance OWASP/CWE pertinente, score détaillé et plan de remédiation priorisé.

## Definition of Done

- [ ] tous les endpoints `app/api/**/route.ts` apparaissent dans l'inventaire API, sans exception ;
- [ ] chaque scénario Cross-Tenant listé dans la commande a une conclusion explicite (protégé / non protégé / non vérifiable) ;
- [ ] chaque finding P0/P1 cite un référentiel (OWASP/CWE) et une preuve fichier:ligne ;
- [ ] aucune valeur secrète réelle n'apparaît dans le rapport.

## Contraintes

- ne modifie pas le produit ;
- ne corrige pas les vulnérabilités ;
- ne modifie ni API, ni DB, ni UI ;
- ne crée ni issue ni PR de correction ;
- seuls `/audits/**` peuvent être modifiés.

## Fin de tâche

Présente : score `/100`, nombre de P0/P1/P2/P3, vulnérabilités Cross-Tenant en premier, confirmées vs potentielles, 10 risques principaux, causes racines, plan de remédiation et fichier d'audit créé.

Arrête-toi après cet audit.
