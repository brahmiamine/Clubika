# Clubika — instructions projet pour les agents

Application **Next.js (App Router) multi-club** de pilotage du planning de clubs de
football : MariaDB + TypeORM, PWA installable, espaces séparés administrateur /
dirigeant et un espace plateforme. Plusieurs clubs partagent la même instance.

Ce fichier est chargé automatiquement par OpenCode. Garder des consignes concrètes
et à jour ; le détail fonctionnel vit dans `README.md`, les tests dans `TESTING.md`.

## Prérequis et commandes

- Node.js 20.x et pnpm 10.x (version pinnée via `packageManager`) → `corepack enable`.
- Installation : `pnpm install`.
- Développement : `pnpm dev` (exécute `start.sh` : Docker + MariaDB + phpMyAdmin,
  puis `next dev`).
- Contrôles à lancer avant de conclure un changement :
  - `pnpm lint`
  - `pnpm type-check`
  - `pnpm test` — Vitest. Les `*.test.ts` qui appellent `getDb()` sont des tests
    d'intégration contre une **vraie MariaDB**, jamais mockés (ils se sautent si
    aucune base n'est joignable, sauf `REQUIRE_DB_TESTS=1`).
  - `pnpm run e2e` — Playwright ; démarre `tsx server.ts` (port 3100) lui-même.
  - `pnpm build` si le changement touche le build/déploiement.
  - `pnpm run privacy:fixtures` si des données/fixtures sont touchées.

## Architecture

- `app/` : routes et UI Next.js (App Router). Routes API dans
  `app/api/**/route.ts`. Pages par espace : `app/club` (admin),
  `app/mon-planning` (dirigeant), `app/plateforme` (plateforme), `app/partage`
  (liens publics).
- `app/components/` : composants React (shadcn/Radix + Tailwind 4).
- `app/lib/` : logique métier et accès données, par domaine (`planning`, `auth`,
  `chat`, `notifications`, `retention`, `privacy`, `observability`, `db`, …).
- `app/lib/db/` : accès MariaDB (`getDb()`), migrations via `pnpm db:migrate`.
- `e2e/` : suites Playwright. `scripts/`, `deploy/`, `security/`, `docs/` :
  outillage, déploiement, sécurité, documentation.
- Alias TS : `@/*`, `@/lib/*` → `app/lib/*`, `@/components/*` → `app/components/*`.

## Conventions de code

- TypeScript strict (`noUnusedLocals`, `noUncheckedIndexedAccess`, …) : ne pas
  contourner avec un `any` non justifié ni `@ts-ignore`.
- **Commentaires, docs et messages utilisateur en français** ; identifiants de
  code en anglais, comme le reste du dépôt. Un commentaire explique le *pourquoi*
  (contrainte, issue liée), pas le *quoi*.
- Pas de `console.*` dans le code applicatif (règle ESLint `no-console`) :
  utiliser `@/lib/observability/log` (serveur) ou le logger client. Exceptions
  autorisées par la config : tests, `e2e/`, `scripts/`, `scraper.js`, `public/sw.js`.
- Pas d'import direct de `pino`/`winston`/`bunyan` (`no-restricted-imports`).
- Réutiliser les helpers existants avant d'en créer ; suivre les patterns du
  domaine concerné.
- Chaque route API critique a un `route.test.ts` voisin — inventaire :
  `pnpm run routes:coverage`.

## Multi-club et isolation des données (critique)

- Chaque donnée est isolée par `clubId` : ne jamais lire/écrire sans contexte club.
- Le contexte club ambiant est posé par `setCurrentClubId()` (`AsyncLocalStorage`,
  `app/lib/auth/club-context.ts`) au début de chaque handler ; `getCurrentClubId()`
  échoue bruyamment s'il manque — **aucun fallback silencieux sur `APP_CLUB_ID`**
  (issue #333).
- Dans les tests, après un appel direct de handler, fixer explicitement le contexte
  avec `runWithClubId(clubId, () => ...)` avant d'appeler une lib qui lit le contexte
  ambiant (piège détaillé dans `TESTING.md`).
- Toute donnée exposée doit respecter les frontières publiques
  (`app/lib/privacy-invariants/`) et la politique de rétention
  (`app/lib/retention/policy.ts`).

## Sécurité et données personnelles

- **Ne jamais committer de secret** : `.env` est ignoré par git, utiliser
  `.env.example` comme gabarit. Le dépôt est scanné par Gitleaks et Trivy.
- `APP_ENCRYPTION_KEY` (AES-256-GCM) est obligatoire en production.
- Tests et fixtures : uniquement des données sentinelles fictives (domaines
  `.test`/`.invalid`/`.example`, numéros `0600000000`…), via
  `app/lib/privacy-invariants/sentinel-factory.ts` — jamais un nom/e-mail plausible.
  Contrôle : `pnpm run privacy:fixtures`.
- Une PR qui ajoute un champ à un DTO/export/notification public doit mettre à jour
  `app/lib/privacy-invariants/public-schema-allowlist.test.ts` et déclencher une
  revue privacy (voir `.github/pull_request_template.md`).

## Outils GitHub (MCP)

`opencode.jsonc` déclare le **GitHub MCP Server** officiel (`github`) sous
`mcp.servers`. Il donne à l'agent les outils GitHub (issues, pull requests,
revues, dépôts). L'authentification est OAuth et **par utilisateur** : lancer
`/mcps` dans OpenCode, choisir `github` et se connecter. Tant que ce n'est pas
fait, `opencode mcp list` affiche `needs authentication` — c'est normal, et le
serveur n'est simplement pas disponible. Aucun secret n'est versionné.

## Processus

- Branche de travail : `dev`. Ne pas pousser directement sur `main`.
- Lint, type-check, build, tests et e2e sont bloquants en CI
  (`.github/workflows/ci.yml`).
- Remplir le template de PR, en particulier la checklist données personnelles.
- Ne pas modifier `pnpm-lock.yaml` à la main : passer par pnpm.
