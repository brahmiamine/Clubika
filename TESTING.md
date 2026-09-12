# Tests

Ce projet utilise [Vitest](https://vitest.dev) pour les tests unitaires et d'intégration,
et [Playwright](https://playwright.dev) (`@playwright/test`) pour les parcours navigateur
bout-en-bout (issue #207).

```bash
pnpm test           # exécute la suite Vitest une fois
pnpm test:watch     # mode watch
pnpm test:coverage  # avec couverture
pnpm run e2e        # exécute la suite Playwright (démarre le serveur applicatif lui-même)
```

`pnpm run e2e` a besoin d'une MariaDB joignable avec les identifiants par défaut
(`clubika`/`clubika_user`/`clubika_password`, port 3306, comme `pnpm test`) et des navigateurs
Playwright installés (`pnpm exec playwright install --with-deps chromium`, déjà fait par le
`postinstall` du dépôt). Le serveur (`tsx server.ts`, port 3100) est démarré et arrêté
automatiquement par `playwright.config.ts` — inutile de le lancer à la main. Pour cibler un
serveur déjà démarré ailleurs, définir `E2E_BASE_URL`.

## CI

Le workflow `.github/workflows/ci.yml` exécute, dans des jobs séparés et **tous
obligatoires avant merge** : `pnpm lint` (socle `--max-warnings`), `pnpm type-check`,
`pnpm build`, `pnpm run db:migrate` suivi de `pnpm test` contre un service MariaDB
(`REQUIRE_DB_TESTS=1` : une base injoignable échoue au lieu de sauter la suite
d'intégration), `pnpm run routes:coverage -- --check` (socle des routes critiques,
issue #286), et `pnpm run e2e` (Playwright, contre son propre service MariaDB). Un
échec de n'importe lequel de ces jobs bloque le merge.

## Tests d'intégration (vraie base, pas de mock)

Les fichiers `*.test.ts` qui appellent `getDb()` sont des tests d'intégration contre une
vraie MariaDB — jamais de mock de la base. Ils utilisent les mêmes identifiants que
`start.sh` (`clubika`/`clubika_user`/`clubika_password`, port 3306), se sautent
automatiquement (`describe.skipIf(!(await isDbAvailable()))`) si aucune base n'est
joignable en local, et la CI leur fournit un service `mariadb`. En CI,
`REQUIRE_DB_TESTS=1` transforme cette indisponibilité en échec (issue #286).

### Piège : le contexte club ambiant ne survit pas à un appel de route direct

`getCurrentClubId()` (`app/lib/auth/club-context.ts`) repose sur `AsyncLocalStorage`,
posé par `setCurrentClubId()` (`enterWith`) au début de chaque handler de route. Dans un
test qui appelle un handler de route **directement** (sans passer par HTTP), puis
appelle ensuite une fonction de lib qui lit `getCurrentClubId()` de façon ambiante
(ex. `getPlanningEventSnapshot`, `getPublishedPlanningEventSnapshot`,
`getPlanningRecord`), le contexte observé après le retour de l'`await` sur le handler
n'est **pas garanti** être celui que ce handler vient de poser : selon l'historique
d'exécution du fichier de test (un test précédent ayant lui aussi posé un club via
`enterWith`), l'appel peut lire un club différent — silencieusement, sans lever d'erreur
« contexte manquant », juste en ne trouvant pas la ligne attendue.

**Règle** : après un appel de route direct, si le test doit ensuite appeler une fonction
de lib qui dépend du contexte club ambiant, fixer explicitement ce contexte avec
`runWithClubId(clubId, () => ...)` plutôt que de compter sur ce que le handler a laissé
derrière lui :

```ts
const snapshot = await runWithClubId(clubId, () => getPlanningEventSnapshot(db, 'entrainement', id));
```

Une fonction qui prend `clubId`/`user` en paramètre explicite (ex. `savePublishedPlanning`,
`savePlanningRecord` avec `clubId` fourni) n'a pas ce problème.

## Matrice de couverture par parcours métier

Legend : ✅ couvert (tests d'intégration API et/ou unitaires) — 🟡 partiellement couvert —
🌐 couvert aussi par un test navigateur bout-en-bout Playwright (`e2e/`).

| Parcours prioritaire (issue #155) | Couverture actuelle |
|---|---|
| 1. Import/scrape → correction → validation → publication globale | 🟡🌐 `global-publication.test.ts` (logique pure, mockée) + `app/api/planning/publication-all/route.test.ts` (bout-en-bout API : aperçu, blocages, publication) + `e2e/publication-cycle.spec.ts` (bout-en-bout navigateur) ; scraper non testé (voir Hors périmètre) |
| 2. Utilisateur voit uniquement le publié → confirme/refuse | ✅🌐 `app/api/me/assignments/respond/route.test.ts` (accepte puis refuse une affectation publiée, motif de refus requis), `e2e/publication-cycle.spec.ts` (invisible avant publication, visible et acceptable après, dans un vrai navigateur) |
| 3. Suppression/annulation et notifications | 🟡 `app/api/entrainements/deferred-delete.test.ts` (suppression différée), `app/api/planning/publication/route.test.ts` (annuler/rouvrir) ; notifications testées unitairement (`app/lib/notifications/*.test.ts`), pas bout-en-bout avec un vrai envoi |
| 4. Échange et liste d'attente | ✅ `app/api/planning/assignment-swaps/route.test.ts` (atomicité approbation), `app/lib/planning/assignment-swaps.test.ts` ; liste d'attente : `app/lib/planning/waitlist` unitaire |
| 5. Multi-club négatif | ✅🌐 `app/lib/db/multi-tenant-event-ids.test.ts`, `app/api/matches/[id]/audit-log/route.test.ts`, isolation vérifiée sur audit/échanges/événements ; `e2e/club-isolation.spec.ts` (un club B ne voit jamais le planning publié d'un club A, dans un vrai navigateur) |
| 6. Modules optionnels désactivés | 🟡 `app/lib/planning/feature-guard` couvert unitairement ; parcours UI complet (navigation + chargement partiel de l'espace événement) sans test dédié |
| 7. Présence, vue week-end et export | ✅ `app/api/planning/attendance/route.test.ts` (saisie bloquée avant la fin, acceptée après), `app/api/planning/weekend/route.test.ts`, `EventWorkspaceView.attendance.test.tsx` (UI) |

### Routes API avec test d'intégration dédié

Le ratio codé en dur se périmait à chaque route ajoutée (issue #207) : `pnpm run
routes:coverage` (`scripts/route-test-coverage.mjs`) calcule l'inventaire à jour — total
testé/non testé, et la liste des routes sans `route.test.ts` (`--missing` pour n'afficher
que cette liste, une route par ligne, utile en script). `pnpm run routes:coverage --
--check` compare ce total au socle `scripts/route-test-coverage.baseline.json` et
vérifie qu'auth, partage public, proxy, publication, planning personnel, cron et
réglages de fonctionnalités ont toujours un `route.test.ts` (issue #286). Remonter
`minTested` dans ce fichier quand une route supplémentaire est couverte.

## Tests navigateur bout-en-bout (Playwright, issue #207)

`e2e/` contient la suite Playwright (`@playwright/test`, distincte de la dépendance
`playwright` utilisée par le scraper). Elle démarre le vrai serveur applicatif (`tsx
server.ts`) contre la même MariaDB que les tests d'intégration, jamais de mock.

- **Authentification** : les fixtures (`e2e/fixtures.ts`) créent des comptes directement en
  base (`createTestUserAndSession`, la même fonction que les tests d'intégration API) et
  posent le cookie `session_token` sur le contexte navigateur — le formulaire de connexion
  n'est pas exercé ici (il a son propre test d'intégration API,
  `app/api/auth/login/route.test.ts`), ce qui isole les parcours métier testés d'une
  régression de la page de connexion elle-même.
- **Isolation** : chaque scénario crée son ou ses propres clubs (`freshClubId()`, un id
  aléatoire par exécution) et nettoie ses comptes et `planning_records` en `finally` — aucun
  état partagé entre scénarios, rejouables indéfiniment.
- **Scénarios couverts** (sur les 10 listés dans l'issue #207) :
  1. `e2e/publication-cycle.spec.ts` — flux n°1/2/3 : un événement créé par l'administrateur
     n'apparaît dans `/mon-planning` qu'après publication globale, avec la fonction
     réellement affectée (issue #210), et peut alors être accepté.
  2. `e2e/club-isolation.spec.ts` — flux n°8 : un club B ne voit jamais un événement publié
     du club A, ni en préparation ni via l'API de lecture.
- **Scénarios restants** (échange sans publication du brouillon, série récurrente alignée
  sur le cycle unitaire, dirigeant multi-fonction pour la détection de conflits, invitation
  réclamant un profil existant) sont déjà couverts côté API par des tests d'intégration réels
  (voir la matrice ci-dessus et `assignment-suggestions.test.ts`,
  `recurring-events/[seriesId]/route.test.ts`) mais pas encore par un test navigateur dédié —
  à ajouter au fil de l'eau plutôt que d'élargir cette PR d'infrastructure initiale.

## Hors périmètre (suite à donner)

- Le scraper (`scraper.js`) n'est jamais exécuté contre le site réel en CI et n'a pas de
  test dédié (à mocker si testé un jour).
- Les interactions drag-and-drop (dnd-kit) nécessiteraient `@testing-library/user-event`
  + jsdom (ou un scénario Playwright dédié) ; non couvertes.
