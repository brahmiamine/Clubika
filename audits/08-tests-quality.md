# Audit 08 — Tests et Qualité

**Repository :** `https://github.com/brahmiamine/Clubika`
**Périmètre :** code sur `main` au 2026-09-10 (SHA `8e1c98f`)
**Méthode :** inventaire 185 fichiers `*.test.*` + 5 E2E + exécution réelle des commandes + lecture CI GitHub.

**Correction majeure vs audit 08 précédent :** la CI n’est **pas** verte. L’affirmation « CI 88 / confiance 7/10 » est **fausse** sur `main` actuel.

---

## Sommaire

1. [Score et confiance production](#1-score-et-confiance-production)
2. [Exécution réelle](#2-exécution-réelle)
3. [Infrastructure](#3-infrastructure)
4. [Inventaire](#4-inventaire)
5. [Matrice fonctionnalités → tests](#5-matrice-fonctionnalités--tests)
6. [Multi-tenant / scraping / planning / chat](#6-multi-tenant--scraping--planning--chat)
7. [Qualité des tests, coverage, skips, TypeScript](#7-qualité-des-tests-coverage-skips-typescript)
8. [CI et ce qu’elle ne détecte pas](#8-ci-et-ce-quelle-ne-détecte-pas)
9. [15 tests manquants prioritaires](#9-15-tests-manquants-prioritaires)
10. [Findings](#10-findings)
11. [Stratégie et plan](#11-stratégie-et-plan)
12. [Definition of Done](#12-definition-of-done)

---

## 1. Score et confiance production

**Note : 48 / 100**
**Confiance actuelle avant mise en production : 4 / 10**

Justification confiance : le corpus de tests est **riche** (publication, chat socket, isolation club) mais **main ne passe aucun job CI**. Un merge demain avec CI verte est impossible tant que lint/type-check/test/e2e/build sont rouges. La pyramide existe ; la porte CI est ouverte en apparence (jobs required inconnus côté GitHub) et **échoue** en pratique.

| Dimension | Poids | Note |
|-----------|------:|-----:|
| Couverture fonctionnelle globale | 20 | 14 |
| Règles métier / sécurité multi-tenant | 25 | 16 |
| API / DB | 15 | 8 |
| E2E | 10 | 4 |
| Fiabilité tests / flaky | 10 | 2 |
| CI | 10 | 1 |
| Qualité TypeScript / code | 10 | 3 |

**Findings :** P0 **2** · P1 **8** · P2 **8** · P3 **5**

---

## 2. Exécution réelle

Date : 2026-09-10, workspace Cloud Agent.

| Commande | Résultat réel |
|----------|----------------|
| `pnpm lint` | **FAIL** — 106 warnings > `--max-warnings 99`. 0 errors. Dont `scraper.js:21` `runDomParser` unused. |
| `pnpm type-check` | **FAIL** — 4 erreurs TS : `login/route.ts:115,120` `matchedUser` possibly undefined ; `assignment-state-store.ts:9` unused `requireClubScope` ; `records.club-scope.test.ts:27` unused `sql` ; `sportcorico-parser.test.ts:3` module `jsdom` sans types. |
| `pnpm test` (sans MariaDB) | **FAIL** — `5 failed \| 112 passed \| 68 skipped (185 files)` · `11 failed \| 666 passed \| 286 skipped (963 tests)` · ~19s. Skips = `describe.skipIf(!dbAvailable)` **attendu**. Failed = ALS `Contexte club manquant` (published-planning, personal-planning, assignment-state-store, attachments) + 1 warn socket `CHAT_INSTANCE_COUNT`. |
| `pnpm test:coverage` | **Non exécuté** — script présent, **pas** de provider `@vitest/coverage-*` ni bloc `coverage` dans `vitest.config.ts`. Estimation qualitative uniquement. |
| `pnpm routes:coverage` | **52/92** routes avec `route.test.ts` (40 manquantes). Baseline `minTested: 51`. |
| `pnpm audit --prod` | 20 vulns : 0 critical, 0 high, 15 moderate, 5 low (jspdf→dompurify). |
| `pnpm build` / `pnpm e2e` | Non lancés localement (type-check cassé ; E2E besoin DB). |
| CI GitHub `main` run `34512699676` (push audit 00) | **lint, type-check, build, test, e2e = failure**. Test job : **76 files failed**. E2E : `Contexte club manquant`. Test : même erreur + `ER_NO_REFERENCED_ROW_2` FK sessions + `ER_DUP_ENTRY` `icalToken`. |

Classification des échecs :
- **Bug produit** : `json-migrator.ts:453` ALS au bootstrap (FUNC-001 / DB-001) — casse CI test+e2e.
- **Bug produit TS** : login `matchedUser` (#347) ; import inutilisé.
- **Test / tooling** : `@types/jsdom` manquant ; fixtures FK 0019 ; lint budget 99.
- **Environnement local** : 68 skips sans DB — **normal**.

---

## 3. Infrastructure

| Outil | Config | Commande | CI |
|-------|--------|----------|-----|
| Vitest 4 | `vitest.config.ts` env node, `vitest.setup.ts` | `pnpm test` | job `test` + `REQUIRE_DB_TESTS=1` |
| RTL | `@testing-library/react` | composants | partiel |
| Playwright | `playwright.config.ts` : workers 1, retries CI 1, trace retain-on-failure, chromium, `webServer` `dev:app` :3100 | `pnpm e2e` | job `e2e` |
| Route coverage | `scripts/route-test-coverage.mjs` | `--check` | oui |
| Lint | eslint `--max-warnings 99` | `pnpm lint` | **rouge** (106) |
| tsc | `strict` + `noUnusedLocals` (`tsconfig.json:10-14`) | `pnpm type-check` | **rouge** |

`planning-reminders.yml` : cron applicatif, **pas** PR CI.

---

## 4. Inventaire

| Pattern | Compte |
|---------|-------:|
| `app/**/*.test.ts(x)` | **183** |
| Total `*.test.ts(x)` hors node_modules | **185** (`proxy.test.ts`, `public/sw.test.ts`) |
| `app/api/**/route.test.ts` | **52** |
| `*.test.tsx` | 19 |
| `e2e/*.spec.ts` | **5** |
| `*.integration.test.ts` | 7 |
| `describe.skipIf` | 75 fichiers / 94 blocs (DB only) |
| `it.skip` / `fixme` / `todo` / `only` | **0** |
| `waitForTimeout` app/e2e | **0** |

E2E : `club-isolation`, `publication-cycle`, `chat-direct-message`, `post-publication-republish`, `planning-mobile-responsive` + `fixtures.ts`.

---

## 5. Matrice fonctionnalités → tests

| Domaine | Unit | Comp | API | Integ | E2E | Confiance |
|---------|:----:|:----:|:---:|:-----:|:---:|-----------|
| Auth login | ✅ | ✅ provider | ✅ | ✅ | ❌ form | Haute API / **CI casse login** |
| Rôles admin/dirigeant | ✅ | partiel | ✅ 403s | ✅ | partiel | Haute |
| accessRole vs fonction | ✅ | — | ✅ me/planning | ✅ mig 0010 | — | Haute |
| Multi-tenant | ✅ | — | ✅ | ✅ | ✅ isolation | Haute **si CI verte** |
| Users | — | — | ✅ | ✅ | ❌ | Haute |
| Invitations | — | — | ✅ rawToken | ✅ | ❌ | **Basse UI revoke** (FUNC-002 non couvert) |
| Plateforme clubs CRUD | — | — | login/me only | — | ❌ | Basse |
| SportCorico | ✅ parser+reconcil | bouton | cron | ✅ notifs | ❌ live | **Trompeuse** (parser ≠ prod) |
| Planning / publication | ✅ | partiel | publication-all | ✅ | ✅ cycle+republish | Haute |
| Indispos | ✅ | ✅ list | ✅ | ✅ #337 | ❌ | Haute |
| Mon Planning | ✅ | — | ✅ | ✅ | ✅ | Haute |
| Archives | ✅ | ✅ | ✅ isolation | ✅ | ❌ | Haute |
| Notifications | ✅ matrix href | ✅ view | ✅ | ✅ outbox | ❌ | Moyenne |
| Chat / mentions | ✅ policy | ✅ | **HTTP manquant** | ✅ socket | ✅ DM | Haute RT |
| Socket.IO | — | — | — | ✅ #346 | ✅ resume | Haute |
| Web Push / PWA | ✅ vapid/sw | — | **0 route.test** | — | ❌ | Basse |
| Config / flags | ✅ | ✅ tab | ✅ | ✅ | ❌ | Haute |
| Exports | ✅ | ✅ button | ✅ | — | ❌ | Moyenne (pas A/B) |
| Responsive | — | TabBar/Shell | — | — | ✅ 390px planning | Moyenne |
| DB / migrations | — | — | — | ✅ runner+FK | — | **FK vs fixtures cassés** |

---

## 6. Multi-tenant / scraping / planning / chat

**Cross-tenant :** events, users, invitations, indispos, archives, chat socket, settings scraping — tests A/B présents. **Trous :** export, push, notifications id probe, directory CRUD, chat HTTP.

Corrélation 02 : 0 IDOR confirmé sans test = pas de P0 sécu ici ; **TEST-001** (chat HTTP) reste P1 régression.

**SportCorico vs 18 scénarios :** voir audit 03. Fixtures HTML **oui**. Prod path **non testé**. DST scrape **non**.

**Planning :** règles côté API/lib (pas seulement bouton disabled). Trous : publication-all dirigeant 403 ; POST blockers ; concurrent 2 admins.

**Chat/RT :** socket fort ; HTTP 7 routes sans test ; push 3 routes sans test ; logout purge non testé.

---

## 7. Qualité des tests, coverage, skips, TypeScript

- `toBeDefined`/`toBeTruthy` : 44 hits / 16 fichiers — mixte.
- `vi.mock` : 161 / 45 fichiers.
- Skips durs : 0. Conditionnels DB : fail-closed en CI via `REQUIRE_DB_TESTS=1`.
- Coverage code : **non mesurée / non gated**.
- `as any` app : 0 ; `@ts-ignore` : 0 ; `: any` : ~9 ; `as unknown as` : ~44.
- God files : `ChatConversation.tsx` ~1530, `scraper.js` 1309, `chat/service.ts` ~1019, `json-migrator.ts` ~734, `published-planning.ts` ~752.
- Lint budget 99 **dépassé** (106) — la porte qualité s’est refermée.

---

## 8. CI et ce qu’elle ne détecte pas

| Job | Commande | Obligatoire fichier | État `main` 2026-09-10 |
|-----|----------|---------------------|------------------------|
| lint | `pnpm lint` | oui dans workflow | **FAIL** 106>99 |
| type-check | `tsc --noEmit` | oui | **FAIL** 4 TS |
| build | `next build` | oui | **FAIL** (mêmes TS) |
| test | migrate + `pnpm test` + routes:coverage | oui + MariaDB | **FAIL** 76 files |
| e2e | migrate + playwright | oui + MariaDB | **FAIL** ALS |
| coverage % | — | non | n/a |
| reminders | cron curl | non | skipped/ok selon vars |

Protection de branche GitHub : **non déterminable** dans le repo (paramètre forge).

### Ce que la CI ne détecterait pas **même verte**

Exemples concrets (pas génériques) :

1. **Parser SportCorico prod** : tests verts sur `sportcorico-parser.dom.js` pendant que `scraper.js` ignore `categorie` (SCRAPE-001).
2. **Révocation invitation UI** : DELETE testé avec `rawToken`, UI envoie le hash (FUNC-002).
3. **`PUT /api/matches/[id]` indispo** : validation testée seulement via `saveRoleAssignments`.
4. **Chat HTTP leak Club B** : pas de `route.test.ts` rooms/messages.
5. **Push après logout** : routes push non testées.
6. **`POST publication-all` en dirigeant** : 403 non asserté.
7. **Publish avec blockers** : helpers unitaires, pas le POST API.
8. **Deux admins concurrent publish** : pas de test.
9. **Export JSON Club B avec session A**.
10. **Plateforme clubs CRUD**.
11. **DnD préparation** (TESTING.md le note).
12. **Login UI club selector** (API #347 testée, pas le form).
13. **Overflow 320px / dialogs / chat mobile**.
14. **Jusqu’à 99 warnings ESLint** — et **aujourd’hui 106 font déjà échouer**.
15. **Chute de coverage statements** — aucun gate.

**Aujourd’hui la CI détecte** (bruyamment) le bootstrap ALS et le budget lint — mais **en rouge**, donc elle ne sert plus de filet de merge.

---

## 9. 15 tests manquants prioritaires

| # | P | Scénario | Niveau |
|---|---|----------|--------|
| 1 | P0 | `getDb()` / login / E2E sur DB vide sans ALS — bootstrap JSON | Integration |
| 2 | P0 | Lint/type-check verts (garde-fous existants cassés) | CI |
| 3 | P1 | Invitation DELETE avec `invitation.id` (contrat UI) | API |
| 4 | P1 | Chat HTTP rooms/messages/direct : unauth, cross-tenant | API |
| 5 | P1 | `POST publication-all` dirigeant → 403 | API |
| 6 | P1 | `POST publication-all` blockers → 409 | API |
| 7 | P1 | Push subscribe/unsubscribe + logout purge | API |
| 8 | P1 | Parser **prod** `scraper.js` vs fixture HTML (ou brancher `runDomParser` + tester) | Unit |
| 9 | P1 | Fixtures user→session compatibles FK 0019 | Integration |
| 10 | P1 | Plateforme clubs CRUD auth | API |
| 11 | P2 | Concurrent two-admin publish | Integration |
| 12 | P2 | Export cross-tenant deny | API |
| 13 | P2 | `PUT matches` indispo doit échouer si flag ON | API |
| 14 | P2 | Overflow 320px + dialog + chat | E2E |
| 15 | P2 | Invitation claim + révocation navigateur | E2E |

---

## 10. Findings

### TEST-001 — P0 — CI `main` entièrement rouge
Run `34512699676` : 5/5 jobs failed. **CI trompeuse au sens inverse** : on ne peut plus s’appuyer sur un vert pour merger, et l’historique récent (plusieurs pushes docs) est rouge depuis les PR #373/#374.
**Cause :** cumul FUNC-001 + lint 106 + TS login/jsdom + FK fixtures.

### TEST-002 — P0 — Bootstrap JSON + ALS casse la suite DB/E2E
Même preuve que FUNC-001. 76 files failed en CI. Flaky selon ordre (premier `getDb()` avec ALS « gagne »).

### TEST-003 — P1 — Invitation revoke non testé avec l’id UI
`invitations/[token]/route.test.ts:97-100` rawToken only.

### TEST-004 — P1 — 7 routes chat HTTP sans test
Liste `pnpm routes:coverage`.

### TEST-005 — P1 — Push API 0 tests
### TEST-006 — P1 — publication-all sans 403 dirigeant ni 409 blockers
### TEST-007 — P1 — Parser fixtures ≠ `scraper.js`
### TEST-008 — P1 — Fixtures cassées par FK 0019 / unique icalToken
### TEST-009 — P1 — type-check cassé (`matchedUser`, jsdom types, unused)
### TEST-010 — P1 — lint 106 > 99
### TEST-011 — P2 — Plateforme clubs* non testés
### TEST-012 — P2 — Pas de concurrent publish
### TEST-013 — P2 — E2E gaps login UI / indispo / invitation / DnD
### TEST-014 — P2 — Matrice notifs = deep-links only
### TEST-015 — P2 — `test:coverage` sans provider
### QUAL-001 — P2 — God files (scraper, ChatConversation, service)
### QUAL-002 — P3 — `max-warnings 99` masquait la dérive jusqu’à 106
### QUAL-003 — P3 — 44 asserts faibles ; 161 mocks
### QUAL-004 — P3 — 44 `as unknown as`
### QUAL-005 — P3 — Audit 08 précédent stale (3 E2E, CI verte)

---

## 11. Stratégie et plan

**Pyramide adaptée :**
1. Unit parser **unique** + règles publication/validation (rapide).
2. Integration DB avec `runWithClubId` **systématique** + factories FK-safe.
3. API critiques : auth, publication-all, invitations contrat UI, chat HTTP, push.
4. E2E : 5 journeys actuels **plus** invitation et login UI — pas de Playwright pour tout.

**Règle future :** bug → test rouge → fix → vert → non-régression. **Interdite :** tester un contrat (rawToken) différent de l’UI (hash).

**Remédiation priorisée :**
1. Fix `migrateJsonData` club explicite (débloque test+e2e).
2. Fix 4 erreurs tsc + 7 warnings lint (revenir ≤99) **ou** relever le seuil **en connaissance de cause**.
3. Factories sessions après insert user.
4. Tests TEST-003 à TEST-007.
5. Brancher parser unique (qualité scrape).

---

## 12. Definition of Done

- [x] Matrice domaines complète
- [x] 15 tests manquants triés par risque + niveau
- [x] « Ce que la CI ne détecterait pas » avec exemples concrets
- [x] Commandes exécutées citées avec **résultats réels** (pas estimés)

**Pyramide :** saine sur le papier, **hors service** tant que `main` est rouge.
