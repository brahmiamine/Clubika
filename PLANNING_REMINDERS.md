# Relances automatiques du planning

Les relances automatiques des affectations en attente sont déclenchées soit par le
**cron du VPS** (`deploy/scripts/install-cron.sh`, recommandé en production), soit par
GitHub Actions via le workflow `.github/workflows/planning-reminders.yml`.

N'activez **pas** les deux en même temps : chaque exécution enverrait les relances en double.

Le workflow peut s'exécuter toutes les heures, à la minute 15, et appelle :

```text
POST /api/cron/planning-reminders
Authorization: Bearer <secret>
```

Le job horaire reste **désactivé par défaut** tant que la cible de production n'a pas été validée manuellement.

## 1. Variable d'environnement sur l'application déployée

Sur l'hébergeur de l'application, définir :

```text
CRON_SECRET=<une-valeur-aléatoire-longue-et-unique>
```

Utiliser une valeur aléatoire d'au moins 32 octets. Ne pas la committer dans le dépôt.

La route `POST /api/cron/planning-reminders` compare l'en-tête Bearer à cette variable `CRON_SECRET`.

## 2. Secrets GitHub Actions

Dans GitHub : **Repository → Settings → Secrets and variables → Actions → Secrets**.

Créer exactement ces deux secrets :

### `CLUBIKA_BASE_URL`

URL publique HTTPS de l'application déployée, sans chemin d'API.

Exemple :

```text
https://planning.exemple.fr
```

Le workflow supprime automatiquement un éventuel `/` final avant d'ajouter `/api/cron/planning-reminders`.

### `CLUBIKA_CRON_SECRET`

Copie exacte de la valeur `CRON_SECRET` configurée sur l'application déployée :

```text
CLUBIKA_CRON_SECRET == CRON_SECRET (application déployée)
```

Le secret n'est jamais placé dans l'URL ni affiché explicitement dans les logs.

## 3. Valider manuellement avant d'activer le schedule

Ne créez pas encore la variable d'activation.

1. Ouvrir **Actions → Planning reminders**.
2. Utiliser **Run workflow**.
3. Vérifier que `Preflight planning reminders` et `Trigger planning reminders` terminent avec succès.
4. Vérifier côté application que l'appel cron a bien été reçu et que les relances dues ont été traitées.

Le déclenchement manuel fonctionne même lorsque le schedule est désactivé.

Si un des deux secrets manque, le préflight manuel échoue immédiatement avec un message explicite, sans afficher la valeur du secret.

## 4. Activer les exécutions horaires

Seulement après le succès du test manuel, ouvrir :

**Repository → Settings → Secrets and variables → Actions → Variables**

Créer la variable :

```text
CLUBIKA_SCHEDULE_ENABLED=true
```

À partir de ce moment, le job planifié s'exécute toutes les heures à la minute 15.

Pour suspendre les relances planifiées sans modifier le workflow, supprimer cette variable ou mettre une valeur différente de `true`. Les déclenchements `schedule` seront alors **skipped** et ne mettront pas le dépôt en rouge.

## Sécurité

- Ne jamais mettre `CRON_SECRET` ou `CLUBIKA_CRON_SECRET` dans un fichier versionné, une issue ou un commentaire de PR.
- Utiliser uniquement l'URL HTTPS publique dans `CLUBIKA_BASE_URL`.
- Faire tourner le secret immédiatement s'il est exposé.
- Le endpoint cron est appelé avec `Authorization: Bearer ...`; le secret n'est pas placé dans l'URL.
- `CLUBIKA_SCHEDULE_ENABLED` n'est pas un secret : il ne contient aucune donnée sensible et sert uniquement d'interrupteur.
