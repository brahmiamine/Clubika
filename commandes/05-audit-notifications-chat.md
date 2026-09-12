# Commande — Audit Notifications, Chat et Temps Réel

Réalise un **audit complet et approfondi des notifications, du chat, de Socket.IO et du Web Push/PWA** du projet **Clubika** à partir du code réel présent sur `main`.

Repository : `https://github.com/brahmiamine/Clubika`

Si `/audits/00-global-cartography.md` et `/audits/02-security-multitenancy.md` existent, réutilise-les pour la cartographie et les contrôles Cross-Tenant déjà établis, mais revérifie toi-même chaque scénario de ce périmètre : les notifications/chat ont leur propre surface de risque non couverte en détail ailleurs.

## Objectif

Vérifier les cycles complets : événement métier → notification DB → temps réel → compteur non lu → notification in-app → Web Push → clic/navigation ; et utilisateur → conversation → message → DB → Socket.IO → destinataire → unread → notification/push → lecture.

Détecte : notifications manquantes ou dupliquées, mauvais destinataires, mauvais liens, messages perdus/dupliqués, unread incohérent, problèmes de reconnexion, erreurs multi-device, push vers mauvais compte, fuite cross-tenant, rooms mal protégées et divergence entre DB/Socket/UI.

## Architecture

Recense tous les fichiers liés à notifications, chat, conversations, messages, mentions, unread, Socket.IO, WebSocket, Web Push, VAPID, PushSubscription, service worker, PWA, rate limiting socket et temps réel.

Construis un tableau fichier/domaine/responsabilité/entrée/sortie.

## Notifications

Recense tous les types réels de notifications et construis une matrice : type, déclencheur, destinataire, in-app, push, route cible.

Analyse au minimum : publication/republication, nouvelle affectation, changement/désaffectation, date/heure/terrain, annulation, report, invitation, indisponibilité, message privé, discussion événement, mention.

Vérifie l'ordre action métier → validation DB → notification. Une opération échouée ne doit pas laisser une fausse notification.

## Publication et notifications

Vérifie si l'affectation pendant la préparation notifie déjà l'utilisateur ou si la notification intervient lors de publication. Analyse les doublons lors de publication de plusieurs matchs et la republication sans changement.

Si une règle métier n'est pas déterminable, marque `Décision produit nécessaire`.

## Chat

Identifie tous les types de conversations et leurs règles de création, visibilité, participants et durée de vie.

Analyse conversation privée, conversation événement, participants, message, mention, historique, suppression éventuelle et unread.

Vérifie les cas : participant désaffecté, utilisateur retiré du club, match archivé/annulé, autre tenant.

## Messages

Détermine la source de vérité. Analyse ordre, pagination, optimistic UI, doubles clics, retries, reconnexion et combinaison Socket + refetch.

Vérifie qu'un message sauvegardé reste récupérable après déconnexion et que Socket.IO n'est pas l'unique source de vérité.

## Socket.IO

Cartographie connexion, authentification, rooms et tous les événements émis/reçus. Vérifie l'existence et l'efficacité d'un rate limiting sur les événements socket sensibles (envoi de message, join room).

Pour chaque room, documente qui peut join/emit et où la permission est contrôlée.

Scénario critique : `User Club A -> conversation/event/room Club B` doit être impossible côté serveur.

Ne fais jamais confiance aux `userId`, `senderId`, `clubId`, `eventId` ou `conversationId` fournis par le client sans vérification serveur.

## Reconnexion et multi-device

Analyse perte réseau, reconnexion, rejoin rooms, messages manqués, resynchronisation unread, plusieurs onglets/appareils et lecture sur un appareil propagée aux autres.

## Unread

Identifie la source de vérité des compteurs messages/notifications (calcul applicatif vs `COUNT` SQL). Analyse mark-one-read, mark-all-read, race conditions et ownership.

`User A -> notification/message unread User B` ne doit jamais être possible.

## Mentions

Analyse parsing, validation du destinataire, droits, notification et risque de double notification `message + mention`.

## Web Push

Cartographie permission → PushSubscription → stockage → envoi → service worker → `notificationclick`.

Analyse VAPID, association subscription/user/device, logout, changement de compte sur même navigateur, plusieurs appareils, subscription expirée 404/410, permission refusée et fonctionnement background/fermé/standalone.

Aucune clé privée ne doit être exposée au client ou copiée dans le rapport.

## Résilience

Analyse les cas Socket indisponible, push indisponible, DB temporairement indisponible, service worker absent. Le produit principal ne doit pas dépendre entièrement d'un canal secondaire.

## Sécurité

Vérifie ownership des conversations/messages/notifications/subscriptions, isolation tenant, XSS dans les messages, URLs dangereuses, validation longueur/payload et rate limiting pertinent.

## Scénarios obligatoires

Analyse ou teste, chacun avec une conclusion explicite (géré / non géré / non vérifiable) : message privé normal, destinataire offline puis reconnecté, double clic envoi, reconnexion socket, deux appareils, conversation autre club, utilisateur désaffecté, message + mention, publication planning, republication, changement affectation, annulation/report, mark-all-read, push background/fermé, subscription 410, logout puis autre compte, mauvais tenant.

## Tests et observabilité

Recense les tests Unit/Integration/E2E couvrant chat, unread, Socket.IO, push et cross-tenant.

Évalue si les logs permettent de comprendre pourquoi un utilisateur n'a pas reçu une notification, sans exposer de données sensibles.

## Findings

Utilise trois familles : `NOTIF-001`, `CHAT-001`, `RT-001`.

Pour chaque finding : priorité, observation, preuve, scénario, impact, cause racine et correction recommandée. Statut : confirmé, très probable, à vérifier dynamiquement ou hardening.

P0 : fuite de conversation/message, impersonation, push mauvais compte ; P1 : mauvais destinataire/message perdu/room mal protégée ; P2 : reconnect/unread/observabilité ; P3 : amélioration mineure.

## Score

Donne une note `/100` avec pondération explicite, par exemple : exactitude des destinataires (20), sécurité multi-tenant chat/socket (25), fiabilité messages/unread (15), Web Push (15), résilience/reconnexion (10), observabilité (5), tests (10).

## Rapport

Crée ou remplace :

`/audits/05-notifications-chat.md`

Inclure : sommaire, architecture, matrice événements/destinataires, chat, messages, mentions, unread, Socket.IO, rooms, reconnexion, push/PWA, sécurité, résilience, observabilité, tests, findings, décisions produit, score détaillé et plan de remédiation.

## Definition of Done

- [ ] les 16 scénarios obligatoires ont chacun une conclusion explicite et sourcée ;
- [ ] chaque room Socket.IO documentée précise la vérification serveur associée (ou son absence) ;
- [ ] la source de vérité des unread est explicitement identifiée (SQL COUNT vs calcul applicatif) ;
- [ ] aucune clé privée VAPID ou secret n'apparaît dans le rapport.

## Contraintes

- ne modifie pas le produit ;
- ne change ni API, ni Socket.IO, ni DB, ni service worker ;
- ne crée ni issue ni PR ;
- seuls `/audits/**` peuvent être modifiés.

## Fin de tâche

Présente : score `/100`, P0/P1/P2/P3, problèmes sécurité/cross-tenant en premier, 10 problèmes majeurs, décisions produit, causes racines, plan de remédiation et fichier d'audit créé.

Arrête-toi après cet audit.
