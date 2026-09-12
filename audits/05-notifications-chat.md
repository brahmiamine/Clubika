# Audit 05 — Notifications, Chat et Temps Réel

**Repository :** `https://github.com/brahmiamine/Clubika`
**Périmètre :** code sur `main` au 2026-09-10
**Méthode :** revue statique + tests (`matrix.test.ts`, `notifications.test.ts`, `socket-server.integration.test.ts`, e2e `chat-direct-message.spec.ts`). Socket/push device **non vérifiés dynamiquement**. Aucune clé VAPID privée dans ce rapport.

**Correctifs désormais dans le code (ancien audit obsolète) :** #345 event rooms, #346 cross-club send, #348 republish noop, #352 rate-limit DB, #344 logout push, #343 badge chat MobileTabBar.

---

## Sommaire

1. [Score](#1-score)
2. [Architecture](#2-architecture)
3. [Matrice notifications](#3-matrice-notifications)
4. [Publication et notifications](#4-publication-et-notifications)
5. [Chat, messages, mentions](#5-chat-messages-mentions)
6. [Socket.IO et rooms](#6-socketio-et-rooms)
7. [Unread](#7-unread)
8. [Web Push / PWA](#8-web-push--pwa)
9. [Résilience, sécurité, observabilité](#9-résilience-sécurité-observabilité)
10. [Scénarios obligatoires](#10-scénarios-obligatoires)
11. [Findings](#11-findings)
12. [Décisions produit](#12-décisions-produit)
13. [Plan de remédiation](#13-plan-de-remédiation)
14. [Definition of Done](#14-definition-of-done)

---

## 1. Score

**Note : 82 / 100**

| Dimension | Poids | Note |
|-----------|------:|-----:|
| Exactitude des destinataires | 20 | 16 |
| Sécurité multi-tenant chat/socket | 25 | 23 |
| Fiabilité messages / unread | 15 | 12 |
| Web Push | 15 | 12 |
| Résilience / reconnexion | 10 | 8 |
| Observabilité | 5 | 3 |
| Tests | 10 | 8 |

**Findings :** P0 **0** · P1 **2** · P2 **6** · P3 **3**

---

## 2. Architecture

| Fichier | Domaine | Responsabilité |
|---------|---------|----------------|
| `app/lib/notifications/service.ts` | notifs | enqueue in-app + outbox **dans** TX métier |
| `app/lib/notifications/outbox.ts` | delivery | push/email/WhatsApp retry, `idempotency_key` UNIQUE |
| `app/lib/notifications/preferences.ts` | prefs | canaux, urgence |
| `app/lib/notifications/destinations.ts` | deep-links | href par type |
| `docs/notifications-matrix.md` | contrat | 21+ types documentés |
| `app/lib/chat/socket-server.ts` | Socket.IO | auth, rooms, events, RL |
| `app/lib/chat/socket-rate-limit.ts` | RL #352 | table `chat_rate_limit_events` |
| `app/lib/chat/service.ts` | SoT messages | chiffrés, sequence, clientMessageId |
| `app/lib/chat/policy.ts` | authz | `canAccessChatRoom` |
| `app/lib/chat/notifications.ts` | chat→notif | DM, event, mention |
| `app/lib/push/service.ts` | Web Push | VAPID serveur |
| `public/sw.js` | SW | `push` + `notificationclick` |
| `app/hooks/useUnreadChatCount.ts` | badge | #343 |
| `app/hooks/useUnreadNotificationsCount.ts` | badge | poll + event |

**Ordre garanti :** écriture notification **dans** la transaction métier ; `deliverEnqueuedNotifications` **après** commit. Une opération rollbackée ne laisse pas de fausse notif.

---

## 3. Matrice notifications

Source canonique `docs/notifications-matrix.md` + `matrix.test.ts` (deep-links, pas le delivery complet).

| Catégorie | Types | In-app | Push | Route |
|-----------|-------|:------:|:----:|-------|
| Publication | `planning-published-*` (5) | ✅ | ✅* | espace événement |
| Affectations doc | `assignment-created/removed` | **morts** | — | — |
| Affectations live | via `planning-published-*` au publish | ✅ | ✅* | espace événement |
| Réponses / swaps | `assignment-response`, `assignment-swap-*` | ✅ | ✅* | événement |
| Dispo | `availability-*` | ✅ | ✅* | inbox |
| Chat | `chat-dm`, `chat-event-message`, `chat-channel-message`, `chat-mention` | ✅ | ✅* | `/club/chat?roomId=` |
| Scrape | `official_match_*` (#336) | ✅ admins | ✅* | — **absents de la matrice doc** |
| Review indispo | `availability-reviewed` (si émis) | ? | ? | **trou matrice** |

\*selon préférences + urgence (`preferences.ts`).

---

## 4. Publication et notifications

| Question | Réponse prouvée |
|----------|-----------------|
| Affectation draft notifie ? | **Non** — `assignment-propagation.ts:8-23` |
| Publication notifie ? | **Oui** si `diff.changed > 0` — `global-publication.ts:377-432` |
| Republication identique | **Pas de notif** #348 |
| Doublon multi-match | clé outbox `(userId, type, eventKey, …)` + `before.publishedAt` |
| `assignment-created` | **aucun caller production** |

---

## 5. Chat, messages, mentions

| Type | `ChatRoomType` | Création | Visibilité |
|------|----------------|----------|------------|
| Direct | `direct` | `POST /api/chat/direct` / socket | participants |
| Canal | `channel` | admin | participants |
| Événement | `event` | lazy | **assignees snapshot publié** + admin (#345, `policy.ts:22-36`) |

- User retiré du club / désaffecté : event room refusée après update snapshot.
- Match archivé : room `archivedAt` → accès denied.
- Autre tenant : `user.clubId !== room.clubId` → false (`policy.ts:32`).

**Messages — source de vérité = DB** (`chat_messages` chiffrés, `sequence` UNIQUE, `clientMessageId` UNIQUE). Socket n’est **pas** SoT. Pagination curseur sequence (`service.ts:548-571`). Optimistic UI côté client ; retry = même `clientMessageId`. **Pas de POST HTTP message** (CHAT-001) — écriture via `chat:send` socket.

**Mentions :** id validé + droits salon ; une personne mentionnée n’a **que** `chat-mention` (pas double général+mention) (`notifications.ts:74-88`, test `:103-124`).

---

## 6. Socket.IO et rooms

| Room | Join | Vérification serveur |
|------|------|----------------------|
| `chat:club:{clubId}:user:{userId}` | handshake après `getSessionUser` | session.user.id / clubId — **pas** trust client |
| `chat:club:{clubId}` | idem | session club |
| `chat:room:{roomId}` | après `chat:resume` + `assertRoomAccess` | `canAccessChatRoom` + participants / assignees |

Événements sensibles : `chat:send` (RL 20/10s), actions 60/10s (`socket-server.ts:292,330`). Handshake global 2000 / IP 40 / 10s (`socket-rate-limit.ts:68-84`). RL **partagé MariaDB** #352.

Club A → conversation Club B : **impossible** + test `:447`.

---

## 7. Unread

| Compteur | Source de vérité |
|----------|------------------|
| Notifications badge | **SQL COUNT** `readAt IS NULL` (`notifications/route.ts:22-26`) |
| Liste notifs | `take: 100` (`:20`) — pas un COUNT total |
| Chat unread | **SQL COUNT** par room (`service.ts:257-270`) |
| Badge MobileTabBar | `useUnreadChatCount.ts` agrège les COUNTs |

Mark-one / mark-all : filtre `userId` session (`notifications/route.ts:71-78`). `User A → unread User B` **impossible** (ownership). Mark room : `ChatReadState` (`service.ts:901-903`) — petite race check-then-save, pas de TX multi-statements.

---

## 8. Web Push / PWA

Permission → `POST /api/push/subscribe` → `push_subscriptions` (`endpoint_hash` UNIQUE) → `triggerPushForUser` → `public/sw.js` `push` / `notificationclick`.

- VAPID **privée** serveur only (`vapid.ts`) ; `GET /api/push/config` = public key.
- Logout : `removeAllPushSubscriptionsForUser` (`auth/logout/route.ts:11`) — **tous** les devices du compte.
- 410/404 endpoint : suppression (`push/service.ts`).
- Compte switch même navigateur : UPSERT réassigne `user_id` (`store.ts:36-37`).

---

## 9. Résilience, sécurité, observabilité

- Socket down : historique HTTP `GET /api/chat/rooms/.../messages` récupérable. Produit principal (planning) **indépendant** du chat.
- Push down : in-app + outbox retry.
- XSS messages : texte React + linkify http(s)/www (`ChatConversation.tsx:154-181`).
- Longueur / payload : validateurs service + upload limits (`fix/218`).
- Logs : erreurs chat/socket génériques ; **pas** de trace « pourquoi user X n’a pas reçu » corrélée à un `notificationId` sans PII — observabilité faible (NOTIF-004).

Tests : socket integ + e2e DM ; **7 routes HTTP chat sans `route.test.ts`**.

---

## 10. Scénarios obligatoires

| # | Scénario | Conclusion | Preuve |
|---|----------|------------|--------|
| 1 | Message privé normal | **Géré** | service + e2e DM |
| 2 | Destinataire offline puis reconnect | **Géré** | DB SoT + e2e resume |
| 3 | Double clic envoi | **Géré** | UNIQUE `clientMessageId` |
| 4 | Reconnexion socket | **Géré** | e2e + rejoin rooms |
| 5 | Deux appareils | **Partiel** | rooms user ; unread SQL ; **logout tue tous les push** |
| 6 | Conversation autre club | **Géré** | policy + test #346 |
| 7 | Utilisateur désaffecté | **Géré** | #345 policy |
| 8 | Message + mention | **Géré** | pas de double notif |
| 9 | Publication planning | **Géré** | diff per user |
| 10 | Republication | **Géré** #348 | skip empty |
| 11 | Changement affectation | **Géré** (différé au publish) | assignment-propagation |
| 12 | Annulation / report | **Géré** au republish | planning-published-cancelled/rescheduled |
| 13 | Mark-all-read | **Géré** | UPDATE userId |
| 14 | Push background/fermé | **Code géré / device non vérifié** | `sw.js` |
| 15 | Subscription 410 | **Géré** | delete endpoint |
| 16 | Logout puis autre compte | **Géré** (purge + UPSERT) | #344 |
| — | Mauvais tenant | **Géré** | policy clubId |

---

## 11. Findings

### NOTIF-001 — P1 — Matrice doc incomplète vs types réels
`official_match_*`, variants swap, éventuellement `availability-reviewed` absents de `docs/notifications-matrix.md`.

### NOTIF-002 — P1 — `assignment-created/removed` documentés mais morts
Aucun caller hors tests. Confusion produit.

### NOTIF-003 — P2 — Inbox `take: 100` sans pagination
`notifications/route.ts:20`.

### NOTIF-004 — P2 — Observabilité delivery insuffisante
Pas de corrélation user-visible « notif X skipped because preference/push 410 ».

### CHAT-001 — P2 — Write path socket-only
Pas de POST HTTP message → indisponible si websocket bloqué (réseau d’entreprise).

### CHAT-002 — P2 — `listChatEvents` N+1
`service.ts:357-367` boucle snapshots.

### RT-001 — P2 — Logout purge **tous** les devices
Multi-device : se déconnecter du desktop coupe le push téléphone. Décision produit.

### RT-002 — P2 — Cap 8 connexions socket **par pod**
Pas global (#258 warn si `CHAT_INSTANCE_COUNT>1`).

### RT-003 — P3 — Routes HTTP chat / push sans tests API
Audit 08.

### CHAT-003 — P3 — Toolbar messages hover-only (mobile)
`ChatConversation.tsx:1224` — UX, corrélation 07.

---

## 12. Décisions produit

**N-1** Notifier une affectation éditée sur un événement déjà publié sans attendre republish ?
A) Non (actuel). B) Oui immédiat. C) Seulement les retraits.

**N-2** `assignment-created` : A) brancher. B) retirer de la matrice. C) garder pour hors-publication seulement.

**N-3** Logout push : A) tous devices (actuel). B) endpoint courant only. C) choix user.

**N-4** Fallback HTTP pour `chat:send` si socket down ?

---

## 13. Plan de remédiation

1. Aligner matrice ↔ code (NOTIF-001/002).
2. Pagination inbox.
3. POST HTTP message (résilience).
4. Trancher N-3 multi-device.
5. Tests API chat HTTP + push (voir 08).

---

## 14. Definition of Done

- [x] 16 scénarios sourcés
- [x] Chaque room a sa vérif serveur
- [x] Unread = SQL COUNT (notifs + chat)
- [x] Aucune clé privée VAPID

**Non vérifié dynamiquement :** push réel background, multi-device physique, reconnexion 3G.
