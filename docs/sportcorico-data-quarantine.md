# Données SportCorico — inventaire, quarantaine et import club (issue #5)

Cette note décrit **uniquement** le traitement des données déjà importées depuis
SportCorico et le parcours de remplacement (saisie manuelle / CSV). Elle ne
réactive pas le scrape.

## Ce que fait la migration `0027`

Au démarrage / `pnpm run db:migrate`, `audit_quarantaine_sportcorico` :

1. parcourt `matches_officiels`, `matches_extras`, les snapshots
   `published-planning` / `published-planning-history`, et `app_meta`
   (`matches_club_info:*`, `matches_url:*`) ;
2. compte les enregistrements qui portent une trace SportCorico (URL, logos
   distants, `details.rawText` / `staff.rawText`, officiels nommés, infrastructure,
   `sourceMatchId`) ;
3. journalise **uniquement des compteurs** (aucun texte de match, aucun nom).

Par défaut (`SPORTCORICO_DATA_PURGE` absent ou différent de `apply`) : **dry-run**,
aucune écriture. La migration est alors marquée appliquée.

## Quarantaine réelle

La quarantaine **n’est jamais lancée depuis une pull request** ni sur une base
de production sans action humaine.

1. Sauvegarder MariaDB (`deploy/scripts/backup-mariadb.sh` ou `mariadb-dump`
   `--single-transaction`). Conserver aussi `APP_ENCRYPTION_KEY` hors du dump.
2. Vérifier que le kill switch SportCorico (issue #4) est en place : plus de
   sync tant qu’une licence écrite n’existe pas.
3. Relire le journal dry-run (compteurs) sur une **copie anonymisée**.
4. Appliquer :

```bash
SPORTCORICO_DATA_PURGE=apply pnpm run sportcorico:quarantine
```

Effet : conservation du calendrier opérationnel (date, heure, équipes,
compétition, catégorie, lieu domicile/extérieur) ; suppression des `rawText`,
officiels nommés, logos distants SportCorico, URL SportCorico, snapshots
`officialSourceSnapshot` ; pose de `importProvenance.quarantined = true`.
Les matchs restent visibles (`sourceStatus` n’est pas passé à `missing`).

La commande est **idempotente**. Un second passage n’écrit plus rien.

## Retour arrière

Restaurer le dump pris à l’étape 1. Il n’existe pas de « undo » applicatif : les
textes et logos retirés ne sont pas archivés ailleurs (volontairement).

## Variables d’environnement

| Variable | Valeurs | Effet |
| --- | --- | --- |
| `SPORTCORICO_DATA_PURGE` | absent / autre | dry-run (migration `0027`) |
| `SPORTCORICO_DATA_PURGE` | `apply` | écritures de quarantaine (script `sportcorico:quarantine`, ou migration si la variable est déjà posée **avant** le premier passage de `0027`) |

## Import autorisé après quarantaine

- **Saisie manuelle** : Planning → Ajouter → Match officiel. Attestation
  obligatoire (`rightsAttested`). `importProvenance.provider = manual`.
- **CSV** : même dialogue, fichier CSV, même attestation.
  `POST /api/planning/official-import`.

Colonnes CSV (en-têtes anglais ou français) :

`date,time,localTeam,awayTeam,venue,competition,categorie,stadium,address`

- `date` : `jj/mm/aaaa`
- `time` : `hh:mm`
- `venue` : `domicile` ou `extérieur`
- toute cellule contenant `sportcorico` ou une URL de logos SportCorico est
  **refusée**

Les futurs imports licenciés doivent porter `importProvenance` (`licensed-api`,
référence de licence). Ce n’est pas un feu vert juridique : voir le label
`needs:legal-review` et l’issue #40.
