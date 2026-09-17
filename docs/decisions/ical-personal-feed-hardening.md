# Durcissement du flux iCal personnel (issue #13)

## Contexte

`/api/ical/[token]` publie un flux `.ics` par abonné, consommé sans session par
l'application de calendrier de l'abonné (Google, Outlook, Apple…). Un jeton connu
suffit à lire le flux tant qu'il n'est pas révoqué : c'est un secret de type
« clé d'API », pas une session authentifiée. Cette note documente les choix pris
pour réduire ce que le flux expose et ce que sa compromission permettrait.

## Divulgation à l'abonné — un fournisseur tiers reçoit ses événements

S'abonner avec l'URL du flux revient à donner à l'application de calendrier
choisie (Google, Outlook, Apple…) un accès récurrent, non supervisé par
Clubika, aux événements et au rôle de l'abonné : ce tiers interroge l'URL
régulièrement et **conserve une copie** des événements chez lui, en dehors du
contrôle de Clubika. `MyCalendarView` (`app/components/planning/MyCalendarView.tsx`)
affiche cet avertissement avant que l'abonné ne génère son lien :

> « En vous abonnant, l'application de calendrier que vous utilisez (Google,
> Outlook, Apple…) interroge régulièrement ce lien et en conserve une copie
> chez elle. Ne le partagez pas : quiconque le possède peut voir vos
> événements et votre rôle. »

## Minimisation du contenu du flux

- **Un seul rôle, une seule identité.** `/api/ical/[token]` construit les
  `identities` de `generateIcal` uniquement à partir des fonctions planning
  (`user.planningFunctions`) et de l'identité (`nom`, `id`) de l'abonné —
  jamais celles d'un tiers.
- **DESCRIPTION ne nomme plus que l'abonné.** `contactNamesForDescription`
  (`app/lib/utils/ical-export.ts`) filtre les listes de contacts (arbitres,
  encadrants, accompagnateurs) sur l'identité de l'abonné dès qu'un filtre par
  personne est actif — flux personnel ou export filtré. Sans filtre (export
  club complet, non personnel), tous les contacts assignés restent visibles :
  seul le flux *personnel* est concerné par cette minimisation.
- **Adresse libre retirée.** Le champ `details.address` (adresse saisie
  librement, potentiellement une adresse privée plutôt que celle du stade)
  n'apparaît plus dans `DESCRIPTION`, pour le flux personnel comme pour
  l'export club. `LOCATION` (nom du stade, déjà présent) suffit pour situer
  l'événement.

## Jeton : empreinte plutôt que valeur brute

Voir `app/lib/planning/ical-token.ts` et la migration `0041`
(`app/lib/db/migrations/schema-migrations.ts`) pour le détail — résumé dans
`docs/database-migrations.md`. `/api/ical/[token]` hache le jeton reçu et
cherche par empreinte (`icalTokenHash`, indexée, unique) ; le jeton brut n'est
jamais stocké après la migration.

## Cycle de vie du jeton

Le jeton brut n'est restitué **qu'une fois**, à l'émission
(`POST /api/users/[id]/regenerate-ical-token`) — comme une clé d'API.
`GET /api/planning/ical-link` n'expose que des métadonnées (`hasToken`,
`createdAt`), jamais le secret ni son empreinte : voir
`app/api/planning/ical-link/route.ts`.

Révocation automatique (jeton mis à `null`, plus de flux actif) déclenchée par :

- désactivation d'un compte (`PUT /api/users/[id]`, transition `active: true → false`) ;
- fermeture de compte (`app/lib/account-closure/close-account.ts`, issue #11) ;
- gel d'un club entier lors de l'offboarding (`app/lib/tenant-offboarding/freeze.ts`, issue #25) ;
- changement d'adresse e-mail confirmé (`app/lib/privacy/rectify.ts`) — l'identité change,
  l'ancien lien ne doit plus fonctionner sous la nouvelle identité.

Révocation ou régénération explicite par l'abonné :
`DELETE`/`POST /api/users/[id]/regenerate-ical-token`, exposées depuis
`MyCalendarView`. Dans tous les cas, l'ancienne URL cesse de fonctionner
immédiatement (même réponse 404 « Lien de calendrier invalide » qu'un jeton
qui n'a jamais existé, pour ne pas distinguer les motifs).

## Ce qui ne change pas

- `Cache-Control: private, no-store` sur la réponse `.ics`.
- Le double rate-limit (IP + jeton, `checkCapabilityIpRateLimit` /
  `checkCapabilityTokenRateLimit`) : les buckets utilisent déjà une empreinte
  du jeton (`hashBucketComponent`), jamais sa valeur brute — inchangé par
  cette issue.
- Le refus identique (même statut, même message) entre club désactivé et
  jeton invalide (issue #213).

## Jeton absent des logs, de l'observabilité et des en-têtes Referer

- Aucun `logError`/`logWarn` du chemin `/api/ical/[token]` ni de
  `regenerate-ical-token` n'inclut le jeton (brut ou haché) : voir les appels
  `logError('app.unhandled', …)` dans les deux routes, qui ne passent que le
  message d'erreur générique et l'objet `Error`, jamais le token ni la requête.
- `app/lib/privacy/export.ts` retire `icalToken`/`icalTokenHash` de tout export
  RGPD (`FORBIDDEN_PAYLOAD_KEYS`).
- Le flux ne définit aucun lien sortant ni redirection qui ferait porter le
  jeton dans un en-tête `Referer` d'une requête tierce déclenchée depuis la
  réponse `.ics` elle-même (pas de ressource externe référencée dans le corps
  du flux).
