# Journalisation structurée (issue #31)

Clubika n’écrit plus de `console.*` applicatif. Tout passe par
`app/lib/observability/log.ts` (serveur) et `client-log.ts` (navigateur).
Les identifiants d’événement vivent dans `events.ts` (pas de `node:crypto`
côté navigateur).

## Schéma

Chaque ligne serveur est un JSON unique :

- `ts` — ISO-8601
- `level` — `error` | `warn` | `info`
- `event` — identifiant allowlisté (`LOG_EVENTS`)
- `correlationId` — UUID par appel
- `tenant` — 12 hex SHA-256 du `clubId` (jamais l’id brut)
- `details` — objet expurgé récursivement (pas de message fournisseur)

Le sink serveur est `process.stdout` / `process.stderr`, jamais `console`.

Le navigateur est **silencieux en production**. En développement il n’accepte que l’event-id.

## Expurgation

Clés : authorization, cookie, token, secret, password, email, phone, IP, endpoint, payload, body, query, user SMTP.

Valeurs : e-mail, JWT, Bearer, IPv4, téléphone, URL avec query/userinfo.

`Error.message` n’est jamais journalisé. Un code interne (`smtp_failed`, `timeout`, …) et `retryable` le remplacent. La stack n’apparaît que hors production, tronquée, sans la requête.

## Outbox `last_error`

Stocke `{"code":"...","retryable":true|false}`. La migration `0028` purge les anciens `error.message`. Dry-run : `MIGRATION_DRY_RUN=1`.

## Accès, destination, rétention

- Destination : stdout/stderr du processus (collecteur d’infra, pas l’application).
- Accès : opérateurs de la plateforme uniquement ; pas d’API métier de lecture des logs.
- Rétention / suppression : à définir avec #9 (durée et prestataire). Tant que #9/#40 ne sont pas tranchés, ne pas activer un agrégateur externe.
- Production : pas de niveau debug. `next.config` retire tous les `console.*` du bundle client.

## Règles PR

ESLint `no-console` (error) et `no-restricted-imports` (pino/winston/bunyan).
Exceptions documentées : tests, `e2e/`, `scripts/`, `scraper.js`, `public/sw.js`.
