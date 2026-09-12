# Cartographie des payloads `simple-json` du planning (issue #128)

Ce document répond au point 1 (« Cartographie ») et au point 2 (« Définir la
frontière ») de l'issue [#128](https://github.com/brahmiamine/Clubika/issues/128).
Il ne modifie aucun schéma existant : c'est une cartographie et une décision de
frontière, préalables à toute normalisation.

## 1. Cartographie

Colonnes `simple-json` (TypeORM) portées par `app/lib/db/schemas.ts`, plus la colonne
`payload LONGTEXT` (JSON sérialisé à la main) de `planning_records`
(`app/lib/db/migrations/schema-migrations.ts`, migration 0001) qui joue le même rôle
pour les enregistrements hors tables dédiées (échanges, liste d'attente, planning
publié, partages…).

| Entité | Champ JSON | Lu fréquemment | Écrit fréquemment | Besoin index | Candidat normalisation |
|---|---|---|---|---|---|
| `MatchOfficial` / `MatchAmical` / `Entrainement` / `Plateau` | `payload` (le `Match`/`Entrainement`/`Plateau` complet) | Oui — chaque chargement de planning | Oui — chaque édition | `date`/`time` déjà sortis en colonnes propres (tri/recherche) ; le reste (staff, détails, catégorie) n'est filtré qu'après lecture complète | Voir §3 |
| `MatchOfficial` / `MatchAmical` / `Entrainement` / `Plateau` | `payload.planningRevision` | Oui (vérification optimiste à chaque écriture) | Oui | Non — comparaison ponctuelle par ligne déjà verrouillée (`pessimistic_write`), pas de requête `WHERE planningRevision = ?` | Oui, si le coût de lecture/désérialisation du payload complet pour ce seul champ devient sensible |
| `MatchOfficial` / `MatchAmical` | `payload.arbitreTouche` / `contactEncadrants` / `contactAccompagnateur` (affectations « brouillon ») | Oui | Oui, à chaque affectation | Oui — recherche « tous les événements où telle personne est affectée » actuellement en scan applicatif (`app/lib/planning/assignment-suggestions.ts`) | Oui (voir #41, déjà entamé côté état opérationnel) |
| `Entrainement` / `Plateau` | `payload.encadrants` | Oui | Oui | Idem ci-dessus | Idem |
| `MatchExtra` | `payload` (`MatchExtras` : statut de publication, révision, affectations « brouillon » des matchs officiels/amicaux) | Oui — à chaque snapshot de planning officiel/amical | Oui — chaque affectation, chaque transition de statut | `planningStatus` très filtré (« publié » vs autres) sans index dédié aujourd'hui | Oui — meilleur candidat du lot (voir §3) |
| `planning_assignment_state` | `state` (TEXT) | Oui | Oui | **Déjà fait** : `club_id, event_type, event_id, role, person_key` sont des colonnes indexées ; seul le détail de l'état (réponse, présence, remplacement…) reste en JSON | Modèle de référence pour la suite (voir §3) |
| `planning_records.payload` | Selon `kind` (`assignment-swap`, `waitlist`, `published-planning`, `public-share`, `person-preference`, `resource`, …) | Variable selon `kind` — `published-planning` est lu à quasiment chaque requête personnelle | Variable — `published-planning` réécrit en entier à chaque publication/patch | `club_id, kind, event_type, event_id, owner_user_id, person_type, person_id` déjà en colonnes indexées ; seul le contenu métier reste en JSON | Déjà hybride (voir §3) — ne pas dégrader |
| `User` | `planningFunctions` | Oui | Rare | Non — 3 valeurs possibles (`arbitre_club`/`encadrant`/`accompagnateur`), filtré en mémoire sur de petits volumes ; le rôle d'accès (`accessRole`) est une colonne scalaire | Non, sauf si le volume d'utilisateurs par club devient très grand |
| `User` | `indisponibilites` | Oui (auto-affectation, suggestions) | Occasionnel | Oui — recherche par plage de dates actuellement en scan applicatif | Candidat à moyen terme si le volume d'indisponibilités par utilisateur augmente |
| `MatchAuditLog` | `before` / `after` | Rare (consultation d'historique) | À chaque écriture auditée | Non — jamais interrogé par contenu, seulement par `entityType`/`entityId`/`createdAt` (déjà indexés) | Non — c'est l'exemple type de JSON à garder : snapshot immuable, jamais requêté par contenu |

## 2. Frontière : ce qui reste JSON, ce qui devient relationnel

**Reste en JSON (décision explicite) :**

- `MatchAuditLog.before` / `after` — snapshots immuables, jamais interrogés par contenu.
  Les rendre relationnels n'apporterait rien et casserait la garantie « avant/après
  fidèle à ce qui existait à l'instant T », y compris pour des champs supprimés depuis.
- Les métadonnées vraiment variables selon `planning_records.kind` (préférences,
  partages, ressources) : le schéma diffère par nature de chaque `kind`, une table par
  `kind` serait une explosion de tables pour un gain de requêtabilité marginal tant que
  le volume reste celui d'un planning de club (pas un SaaS multi-tenant à très grande
  échelle).
- Le détail fin de `planning_assignment_state.state` (raison de refus, historique de
  relances…) : les colonnes qui servent réellement à filtrer/verrouiller
  (`club_id, event_type, event_id, role, person_key, person_type, person_id`) sont déjà
  sorties ; le reste est consulté ligne par ligne, jamais interrogé par sous-champ.

**Candidats à normaliser, par ordre de valeur :**

1. **Statut/révision de publication** (`MatchExtra.payload.planningStatus` +
   `payload.planningRevision`, et l'équivalent enfoui dans `payload` pour
   `Entrainement`/`Plateau`) — participe à l'identité métier (publié ou non change ce
   qu'un compte personnel a le droit de voir), est filtré à chaque requête de dashboard/
   statistiques, et est déjà écrit sous verrou pessimiste : le sortir en colonnes propres
   (`planning_status`, `planning_revision`) sur les 4 tables d'événements et sur
   `MatchExtra` permettrait un index direct et une comparaison `WHERE planning_revision =
   ?` côté SQL au lieu d'une lecture complète + comparaison applicative.
2. **Affectations brouillon** (`arbitreTouche`/`contactEncadrants`/
   `contactAccompagnateur`/`encadrants`) — participent aux règles métier
   (couverture des rôles, conflits, charge) et sont déjà recoupées avec
   `planning_assignment_state` : une table `planning_draft_assignment` avec les mêmes
   colonnes d'identité que `planning_assignment_state` supprimerait le scan applicatif
   de `assignment-suggestions.ts` sur « tous les événements ».
3. **Indisponibilités utilisateur** (`User.indisponibilites`) — à surveiller, pas urgent
   au volume actuel.

**Ne pas traiter ici** (déjà couvert ou explicitement hors périmètre, cf. issue #128) :
état opérationnel des affectations (#41, déjà extrait dans
`planning_assignment_state`), clés tenant-scoped (issues #125/#126, déjà traitées),
audit (`MatchAuditLog`, volontairement gardé en JSON — voir ci-dessus).

## 3. Validation/versionnement mis en place

L'issue #128 introduit désormais `app/lib/db/planning-payload-codecs.ts` comme
frontière runtime pour les payloads de planning les plus critiques :

- `MatchOfficial` et `MatchAmical` ;
- `Entrainement` et `Plateau` ;
- `MatchExtra`.

Les lectures acceptent les payloads historiques **sans** `schemaVersion`, mais
valident les champs structurants et rejettent explicitement les données corrompues.
Les nouvelles écritures effectuées par `event-store` et le scraper utilisent
`schemaVersion: 1`. Il s'agit d'une migration progressive (« lazy migration ») :
aucune réécriture globale risquée n'est nécessaire pour rendre les données existantes
lisibles.

Le format versionné reste volontairement plat :

```json
{
  "schemaVersion": 1,
  "id": "...",
  "date": "...",
  "...": "..."
}
```

Le codec retire `schemaVersion` avant de retourner l'objet métier, afin que cette
métadonnée de stockage ne fuite pas dans les API.

### Pourquoi ne pas sortir `planningStatus` / `planningRevision` en colonnes SQL maintenant ?

Cette normalisation reste le candidat relationnel prioritaire, mais elle modifie
simultanément les règles d'écriture de quatre types d'événements et de `MatchExtra`.
La version actuelle utilise déjà des colonnes dédiées et indexées pour les clés
requêtées par SQL (`clubId`, `id`, `date`, `time` et identités de
`planning_records` / `planning_assignment_state`). Les statuts et révisions sont
lus après sélection de lignes déjà tenant-scopées et ne sont pas actuellement utilisés
comme prédicats SQL critiques.

Le coût/risque d'une migration relationnelle immédiate est donc supérieur au gain.
Si des requêtes SQL commencent à filtrer massivement sur ces champs, la prochaine
migration additive sera : colonnes nullable → backfill depuis JSON → double lecture
temporaire → bascule des écritures → index → retrait du fallback legacy.

## Suivi

- Cette cartographie doit être mise à jour à chaque nouvelle colonne `simple-json` ou
  nouveau `kind` de `planning_records`.
- Tout nouveau chemin d'accès aux cinq payloads couverts doit passer par les codecs,
  et non par un cast TypeScript direct.
- Toute future normalisation SQL doit rester additive et rétrocompatible, avec tests
  sur données historiques et nouvelles et sans régression publication/scraper/historique.
