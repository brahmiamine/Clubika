# Commande — Audit SportCorico et Scraping

Réalise un **audit complet et approfondi du scraping SportCorico** du projet **Clubika** à partir du code réel présent sur `main`.

Repository : `https://github.com/brahmiamine/Clubika`

Si `/audits/00-global-cartography.md` existe, réutilise-le pour situer le scraping dans l'architecture globale, mais revérifie toi-même chaque comportement décrit ici : ce fichier doit rester exploitable seul.

## Objectif

Comprendre et vérifier le cycle complet : configuration club → construction URL SportCorico → récupération HTTP → parsing → normalisation → matching du club → matching du match → création/mise à jour → doublons → disparition → annulation/report → archivage → impact planning/publication.

Je veux détecter : faux matching, doublons, perte de matchs, mises à jour incorrectes, écrasement de données internes, suppression dangereuse, erreurs silencieuses, manque d'idempotence, concurrence, fragilité du parser, problèmes timezone, sécurité SSRF et mauvaise isolation tenant.

## Architecture

Recense tous les fichiers liés directement ou indirectement au scraping : services, API, helpers, configuration, modèles DB, historique, logs, tests et interfaces de déclenchement (y compris `scraper.js`, `app/lib/scraper/**`, tout cron/route de déclenchement automatisé).

Construis un tableau fichier/responsabilité/entrée/sortie/appelé par.

## Configuration SportCorico

Analyse précisément tous les paramètres, notamment `matchesUrlKey` et `scraperClubName` si présents.

Pour chacun : où il est configuré, stocké, validé, utilisé, s'il est obligatoire et pourquoi il existe.

Réponds avec preuve à : **a-t-on réellement besoin de `matchesUrlKey` ET `scraperClubName` ?**

## Déclenchement

Identifie tous les déclencheurs : bouton, API, cron, worker, script, synchronisation implicite. Si un déclenchement cron/automatisé existe, vérifie son authentification (ex. Bearer token, `timingSafeEqual`) et sa protection contre le rejeu.

Vérifie si deux scrapings peuvent être lancés simultanément (même club, ou clubs différents en parallèle) et quelles protections existent (lock applicatif, contrainte DB, verrou distribué).

## HTTP et sécurité

Analyse construction URL, hostname, protocole, paramètres, redirections, timeout, retries, erreurs HTTP, contenu vide et SSRF (l'URL cible peut-elle être influencée par une donnée utilisateur non maîtrisée ?).

Vérifie surtout qu'une panne réseau ou une erreur du parser ne soit jamais interprétée comme « tous les matchs ont disparu » (fail-safe vs fail-open sur une réponse vide/erreur).

## Parsing

Documente les données extraites : date, heure, domicile, extérieur, compétition, catégorie, terrain, lieu, statut, score, journée, identifiant/URL éventuel.

Évalue la robustesse des sélecteurs face à de petits changements HTML (sélecteurs fragiles, dépendance à l'ordre du DOM, absence de fallback).

## Normalisation et matching club

Analyse normalisation casse, espaces, accents, apostrophes, tirets, noms de clubs et équipes.

Vérifie les risques de faux positif ou faux négatif lors du matching du club.

## Identité d'un match

C'est une partie critique.

Détermine exactement comment le code décide qu'un match SportCorico correspond à un match déjà stocké (clé naturelle composite, identifiant externe stable, ou heuristique fragile).

Analyse la stabilité de cette identité si changent : heure, date, terrain, adversaire, compétition ou statut.

## Création, mise à jour et source de vérité

Construis une matrice par champ indiquant : créé par scraper, mis à jour par scraper, modifiable manuellement, préservé lors du rescraping.

Distingue clairement données SportCorico et données internes Clubika.

Vérifie qu'un rescraping ne supprime pas les affectations, notes, publication, chat ou autres informations métier liées au match.

## Scénarios obligatoires

Analyse ou teste, pour chacun avec une conclusion explicite (géré / non géré / non vérifiable) :

- nouveau match ;
- match inchangé ;
- changement heure ;
- changement date ;
- changement terrain ;
- adversaire/compétition renommé ;
- match reporté ;
- match annulé ;
- match disparu ;
- match disparu puis revenu ;
- match créé manuellement puis découvert par SportCorico ;
- match SportCorico supprimé manuellement puis rescrapé ;
- double scraping ;
- scraping concurrent ;
- erreur réseau ;
- HTML invalide ;
- parser retourne 0 ;
- changement d'heure été/hiver ;
- scraping Club A ne touche jamais Club B.

## Idempotence et atomicité

Vérifie qu'exécuter deux fois un scraping identique ne produit pas d'effets supplémentaires inutiles (doublons, notifications superflues, écritures DB redondantes).

Analyse le comportement d'un run partiellement échoué et l'usage éventuel de transactions/locks/contraintes uniques.

## Archives et publication

Analyse comment les matchs disparus, passés, annulés et reportés interagissent avec les archives, les affectations, le planning publié et les notifications.

## Performance et observabilité

Recherche N+1, requêtes DB dans les boucles, insert/update unitaires excessifs et appels HTTP répétés.

Vérifie si un run permet de savoir : nouveaux, modifiés, inchangés, disparus, erreurs — et si ce résultat est loggé/exploitable pour du monitoring (alerte si 0 matchs alors que le club en a habituellement, alerte si taux d'erreur anormal).

## Tests

Recense les tests existants (y compris les fixtures HTML dans `app/lib/scraper/fixtures/**`) et construis une matrice couvrant les scénarios critiques ci-dessus.

Privilégie les fixtures HTML en test. N'effectue aucun test destructif sur un site ou environnement de production. Ne fais jamais de requête réseau réelle vers SportCorico pendant l'audit ; utilise exclusivement les fixtures et tests existants.

## Findings

Utilise `SCRAPE-001`, `SCRAPE-002`, etc.

Pour chaque finding : priorité, observation, preuve, scénario reproductible, impact, cause racine et correction recommandée.

Priorités :
- P0 : corruption/perte massive/cross-tenant ;
- P1 : doublons, matching/report/disparition incorrects ;
- P2 : observabilité, robustesse, performance ;
- P3 : simplification/nettoyage.

## Score

Donne une note `/100` avec pondération explicite, par exemple : identification stable des matchs (25), idempotence/atomicité (15), mises à jour et préservation des données internes (15), gestion disparition/annulation/report (15), robustesse du parsing (10), isolation tenant/sécurité (10), performance (5), tests (5).

## Rapport

Crée ou remplace :

`/audits/03-sportcorico-scraping.md`

Le rapport doit contenir sommaire, architecture, configuration, HTTP, parsing, normalisation, matching, synchronisation, scénarios (tableau avec conclusion par scénario), archives, publication, sécurité, performance, tests, findings, score détaillé et plan de remédiation.

## Definition of Done

- [ ] les 18 scénarios obligatoires ont chacun une conclusion explicite et sourcée ;
- [ ] la question `matchesUrlKey`/`scraperClubName` a une réponse tranchée avec preuve ;
- [ ] la matrice champ/source de vérité couvre tous les champs significatifs d'un match ;
- [ ] aucun test destructif ni appel réseau réel n'a été effectué pendant l'audit.

## Contraintes

Pendant cet audit :
- ne modifie pas le scraper ;
- ne modifie ni API, ni DB, ni UI ;
- ne crée ni issue ni PR ;
- seuls `/audits/**` peuvent être modifiés.

## Fin de tâche

Présente : score `/100`, nombre de P0/P1/P2/P3, 10 risques principaux, causes racines, réponse claire sur `matchesUrlKey`/`scraperClubName`, plan de remédiation et fichier d'audit créé.

Arrête-toi après cet audit.
