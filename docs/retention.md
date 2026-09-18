# Rétention et purge (issue #9)

Les durées ci-dessous sont des **valeurs produit initiales**, configurables par
variable d’environnement. Elles **ne sont pas imposées par la loi**. Une revue
humaine (#12, #40) doit les valider avant données réelles.

Il n’y a **pas d’archivage intermédiaire** des données personnelles : aucune
base légale n’a été fournie pour conserver une seconde copie. La preuve
d’exécution est agrégée dans `retention_purge_runs` (compteurs par catégorie,
sans contenu).

## Matrice

| Catégorie | Variable | Défaut | Finalité | Accès | Purge |
| --- | --- | ---: | --- | --- | --- |
| Chat + PJ chat | `RETENTION_CHAT_DAYS` | 365 | Conversations | participants / admin | blob + métadonnées + message |
| Documents événement | `RETENTION_PLANNING_ATTACHMENTS_DAYS` | 365 | PJ planning | espace événement | blob + métadonnées |
| Rapports post-événement | `RETENTION_REPORTS_DAYS` | 365 | Comptes rendus | espace événement | `planning_records` |
| Audit | `RETENTION_AUDIT_DAYS` | 365 | Preuve d’action | admin club | `match_audit_log` |
| Sessions expirées/révoquées | `RETENTION_SESSIONS_DAYS` | 30 | Auth | système | `user_sessions`, `platform_sessions` |
| Notifications in-app | `RETENTION_NOTIFICATIONS_DAYS` | 180 | Alertes | destinataire | `notifications` |
| Invitations used/expired | `RETENTION_INVITATIONS_DAYS` | 90 | Onboarding | admin | `invitations` |
| Reset mot de passe | `RETENTION_PASSWORD_RESET_DAYS` | 7 | Auth | système | `password_reset_tokens` |
| Push inactifs | `RETENTION_PUSH_DAYS` | 365 | Web Push | système | `push_subscriptions` |
| Journaux scrape | `RETENTION_SCRAPER_RUNS_DAYS` | 90 | Sync source | admin | `scraper_sync_runs` uniquement |
| Outbox notifications | `RETENTION_OUTBOX_DAYS` | 30 | File d’envoi | système | `planning_notification_outbox` |
| Rate limits | `RETENTION_RATE_LIMITS_DAYS` | 14 | Anti-abus | système | buckets hashés |
| Partages publics (filet de sécurité, sur date de création) | `RETENTION_PUBLIC_SHARES_DAYS` | 90 | Liens temporaires anciens, expirés ou non | jeton / admin | `public-share` |
| Partages publics expirés (purge technique courte, sur échéance) | `RETENTION_PUBLIC_SHARES_EXPIRED_DAYS` | 7 | Retirer un lien déjà expiré peu après son échéance | système | `public-share` |

`RETENTION_BATCH_SIZE` (défaut 200) limite chaque DELETE.

Les **événements importés** (matchs, etc.) sont des données opérationnelles du
club : ils ne sont pas purgés ici (offboarding club = issue #25).

## Durée maximale d'un lien de partage public (issue #14)

`app/api/planning/shares/route.ts` propose toujours **7 jours par défaut**, mais la
durée maximale proposée est réduite de **90 à 30 jours**, pour limiter la fenêtre
d'exposition d'un lien transféré ou oublié — sans présenter cette valeur comme une
obligation légale. Configurable par `PUBLIC_SHARE_MAX_EXPIRY_DAYS`, plafonnée en
toute hypothèse à 90 j (l'ancien maximum) pour qu'une mauvaise configuration ne
puisse jamais dépasser la fenêtre déjà couverte par le contrat public existant.

**Traitement des liens déjà émis avec une échéance > 30 jours** : ils **restent
valables jusqu'à leur `expiresAt` d'origine**, sans révocation ni raccourcissement
rétroactif — la génération d'un jeton aléatoire + SHA-256 ne permet de toute façon
pas de « retrouver » ces liens autrement qu'en énumérant `planning_records`, et une
invalidation silencieuse casserait un lien qu'un administrateur a pu diffuser de
bonne foi (affichage club, réseaux sociaux…) en s'appuyant sur la durée annoncée au
moment de la création. Seules les **nouvelles créations** sont plafonnées à 30 jours
(configurable). L'administration (`/club/planning/partage`) affiche un repère visuel
sur les liens dont la fenêtre d'origine dépasse la limite courante, et la purge
technique courte ci-dessus (`RETENTION_PUBLIC_SHARES_EXPIRED_DAYS`, 7 j après
`expiresAt`) s'applique à tous les liens, anciens ou récents, une fois expirés.
Cette décision produit doit être revue par un humain avant données réelles (#12/#40),
au même titre que les autres durées de cette page.

## Job

```
POST /api/cron/retention-purge
Authorization: Bearer $CRON_SECRET
# simulation : ?dryRun=true
```

- Idempotent : une seconde passe ne retire plus rien.
- Isolation par `clubId` (sauf artefacts globaux hashés / sessions plateforme).
- Reprise : une catégorie en échec n’arrête pas les autres ; HTTP 500 si au moins une a échoué (alerte workflow).
- Journaux : `success=`, `failed=chat` — **jamais** de texte, e-mail, IP ou nom.

Workflow GitHub `retention-purge.yml` (quotidien 03:20 UTC), mêmes secrets que les relances planning (`CLUBIKA_BASE_URL`, `CLUBIKA_CRON_SECRET`), interrupteur `CLUBIKA_SCHEDULE_ENABLED`.

## Sauvegardes, caches, exports

| Support | Traitement |
| --- | --- |
| Dumps MariaDB / snapshots VPS | Hors application. L’opérateur applique sa propre rotation ; une purge SQL ne rétroagit pas sur un dump déjà copié. |
| Cache Next.js / CDN | Pas de store de données personnelles métier. |
| Exports CSV/PDF | Générés à la demande, non conservés côté serveur. |
| Logs applicatifs | Voir issue #31 ; ce job n’écrit que des compteurs. |

## Commande manuelle

Dry-run (aucune suppression) :

```bash
curl --fail -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "$APP_BASE_URL/api/cron/retention-purge?dryRun=true"
```

Exécution réelle : omettre `dryRun`. Retour arrière : restaurer un dump d’avant job (les suppressions sont irréversibles).
