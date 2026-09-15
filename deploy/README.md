# Déploiement VPS (OVH, Debian, clubika.com)

Une instance de l’app, MariaDB, Caddy (HTTPS). Pas de réplicas : le chat
est conçu pour un seul processus.

Le runtime est durci (issue #36) : processus app UID 10001, systèmes de
fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges`, réseaux
séparés, images pinnées par digest, secrets en fichiers. Un contrôle
`preflight.sh` **bloque** le déploiement si ces conditions ne sont pas
vérifiables — y compris l’attestation opérateur `HOST_FIREWALL_CONFIRMED=1`.

## 1. DNS, pare-feu, horloge, accès admin

Chez le registrar : enregistrement **A** `clubika.com` et `www` vers l’IP du VPS.

Sur le VPS (Debian) :

- Pare-feu hôte : ouvrir **uniquement 22, 80 et 443**. MariaDB n’est pas
  publiée (réseau Compose `backend` interne). Pas de phpMyAdmin en production.
- SSH : authentification par clé uniquement, pas de mot de passe, pas de root
  login direct.
- Horloge : `sudo timedatectl set-timezone Europe/Paris` et NTP actif
  (`timedatectl status`).
- Moteur Docker : seccomp par défaut (ne pas lancer le démon avec
  `seccomp=unconfined`). AppArmor `docker-default` si le noyau le fournit.
- TLS : Caddy termine HTTPS (Let’s Encrypt). Ne pas exposer l’app hors de
  `127.0.0.1:3000`.

Attendre que le DNS réponde avant `docker compose up` : Caddy demande le
certificat Let’s Encrypt tout de suite.

Attestation bloquante dans `deploy/.env` (à passer à `1` seulement après
vérification réelle) :

```env
HOST_FIREWALL_CONFIRMED=1
```

## 2. Docker

Sur Debian 13, installer le moteur Docker et le plugin Compose v2
(dépôt Docker officiel). Puis cloner le dépôt, par exemple dans `/opt/clubika`.

## 3. Secrets

Les secrets ne sont **pas** dans `.env` (sinon `docker inspect` les affiche).
Ils sont injectés au runtime via des fichiers `deploy/secrets/` montés en
Docker secrets (`*_FILE`).

```bash
cd /opt/clubika/deploy
cp .env.production.example .env
chmod 600 .env
mkdir -p secrets
chmod 700 secrets
umask 077
openssl rand -base64 24 > secrets/mariadb_root_password
openssl rand -base64 24 > secrets/db_password
openssl rand -base64 24 > secrets/db_backup_password
openssl rand -base64 24 > secrets/db_restore_password
openssl rand -hex 32 > secrets/app_encryption_key
openssl rand -hex 32 > secrets/backup_encryption_key
openssl rand -hex 32 > secrets/cron_secret
chmod 600 secrets/*
```

Éditer `.env` : `APP_BASE_URL`, e-mails de bootstrap, `BOOTSTRAP_APPROVAL` /
`PLATFORM_BOOTSTRAP_APPROVAL` (issue #32), `HOST_FIREWALL_CONFIRMED=1`.
Mots de passe bootstrap (optionnels) : `secrets/bootstrap_superadmin_password`
et `secrets/platform_admin_password`.

Clés VAPID : `node scripts/generate-vapid-keys.mjs` depuis la racine du dépôt,
clé publique dans `.env` (`VAPID_PUBLIC_KEY` et `NEXT_PUBLIC_VAPID_PUBLIC_KEY`),
clé privée dans `secrets/vapid_private_key`. SMTP : `secrets/smtp_password`.

Sauvegardez **tout le répertoire `secrets/`** hors du VPS, **séparément** des
dumps. `app_encryption_key` et `backup_encryption_key` doivent être **distinctes**.
Les perdre rend les messages `enc:v2` (clé app) et les dumps `.sql.gz.enc` (clé
backup) illisibles. Les pièces jointes ne sont pas chiffrées par la clé app.

## 4. Lancer

```bash
cd /opt/clubika/deploy
./scripts/preflight.sh
docker compose up -d --build
./scripts/ensure-db-identities.sh
```

`preflight.sh` refuse le lancement si `.env` est lisible par autrui, si un
secret manque, si une image n’est pas pinnée, si MariaDB est publiée, ou si
`HOST_FIREWALL_CONFIRMED` n’est pas à `1`.

L’app migrate puis écoute sur `127.0.0.1:3000`. Caddy expose `https://clubika.com`.
Sondes : `GET /api/health/live` (processus) et `GET /api/health/ready` (SQL +
migrations, sans créer de tenant, sans secret).

Vérifier : `docker compose ps` et ouvrir le site. Se connecter une fois avec les
comptes bootstrap, **puis supprimer les fichiers bootstrap** de `secrets/` et
`docker compose up -d --force-recreate app`.

Monitoring : un sonde HTTP sur `/api/health/ready` (réponse `{ "status": "ready" }`
uniquement). Les journaux Docker sont plafonnés (json-file 10m × 5).

## 5. Cron et dumps

```bash
sudo timedatectl set-timezone Europe/Paris
./scripts/install-cron.sh
```

Cela installe (crontab utilisateur) :

- relances planning chaque heure à :15 (`CRON_SECRET` fichier)
- scraper 7h / 12h / 18h (no-op tant que `SPORTCORICO_SYNC_ENABLED` n’est pas `true` et qu’une licence écrite n’a pas été validée)
- dump MariaDB quotidien à 3h20 dans `deploy/backups/` (14 jours) avec
  l’identité SQL `clubika_backup` (SELECT, pas root), **chiffré** AES-256-GCM
  (`.sql.gz.enc` + `.sha256`). Sans `secrets/backup_encryption_key` le job refuse
  d’écrire un dump en clair.

La sauvegarde OVH « 1 jour » ne remplace pas ces dumps. Copiez les `.enc` **et**
`deploy/secrets/` sur des supports **séparés**.

Preuve de restauration (sans importer) :

```bash
./scripts/restore-mariadb.sh --verify backups/clubika-….sql.gz.enc
```

Rotation de `APP_ENCRYPTION_KEY` : ajouter la nouvelle clé comme active, l’ancienne
dans `APP_ENCRYPTION_PREVIOUS_KEYS`, `pnpm exec tsx scripts/rotate-encryption-keys.ts`
puis `--apply`, ensuite retirer l’ancienne du ring. Compromission : même rotation
en urgence, révoquer les sessions (#29) et les jetons d’invitation.

Ne pas activer le schedule GitHub Actions des relances si ce cron tourne déjà
(doublon). Voir `PLANNING_REMINDERS.md`.

## 6. Mise à jour des images et de l’application

Images de production **et** du service MariaDB de CI : `deploy/runtime-images.lock`
(digests `sha256`). Procédure automatisée :

```bash
./deploy/scripts/refresh-image-pins.sh
pnpm exec vitest run deploy/runtime-hardening.test.ts
```

Puis PR / commit du lock, du Dockerfile, de Compose et de `.github/workflows/ci.yml`.
Le scan CVE / SBOM des images est le ticket #37.

Mise à jour applicative sur le VPS :

```bash
/opt/clubika/deploy/scripts/update.sh
```

Équivalent : `git pull` de `prod`, `preflight.sh`, `docker compose up -d --build`,
`ensure-db-identities.sh`. Une seule instance `app`.

## 7. Restaurer un dump

```bash
./scripts/restore-mariadb.sh --verify backups/clubika-….sql.gz.enc
# environnement isolé :
./scripts/restore-mariadb.sh --restore backups/clubika-….sql.gz.enc
```

Identité `clubika_restore` (DDL/DML sur la base applicative, pas root). Puis
redémarrer `app`. Remettre **la même** `secrets/app_encryption_key` (et
`APP_ENCRYPTION_PREVIOUS_KEYS` si une rotation était en cours) qu’au moment du dump.

## 8. Rollback

```bash
cd /opt/clubika
git fetch origin
git checkout <sha-connu-sain>
./deploy/scripts/update.sh
```

Le préflight s’exécute à nouveau. Si le SHA antérieur exige encore les secrets
fichiers, conservez `deploy/secrets/` (non versionné).

## 9. Déploiement automatique (GitHub → VPS)

Chaque **push** ou **merge de PR** sur la branche `prod` (et un lancement manuel
« Run workflow ») SSH sur le VPS, `git pull` puis `update.sh` (préflight inclus).

### Clé SSH dédiée (une fois)

Sur votre machine :

```bash
ssh-keygen -t ed25519 -f clubika-github-deploy -C "github-actions-clubika" -N ""
```

Sur le VPS, coller **la clé publique** (`clubika-github-deploy.pub`) :

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
cat >> ~/.ssh/authorized_keys <<'EOF'
ssh-ed25519 AAAA… github-actions-clubika
EOF
chmod 600 ~/.ssh/authorized_keys
```

Le dépôt GitHub doit pouvoir être tiré **sans mot de passe** depuis le VPS
(`git pull` en HTTPS public, ou clé de déploiement GitHub si le dépôt est privé).

### Secrets du dépôt GitHub

Settings → Secrets and variables → Actions :

| Secret | Exemple |
| --- | --- |
| `VPS_HOST` | `51.75.31.112` (ou `clubika.com`) |
| `VPS_USER` | `debian` |
| `VPS_SSH_KEY` | contenu **privé** de `clubika-github-deploy` (tout le fichier, y compris `BEGIN`/`END`) |
| `VPS_PORT` | optionnel, `22` par défaut |

Le workflow est `.github/workflows/deploy-prod.yml`. Un seul déploiement à la
fois (`concurrency: deploy-prod`). Le build Docker peut durer plusieurs minutes.

## Risques résiduels

- Egress de l’app (réseau `frontend`) : à restreindre sur le pare-feu hôte
  (SMTP/HTTPS nécessaires). Ticket #30 pour les sorties applicatives.
- Caddy s’exécute en uid 0 avec uniquement `NET_BIND_SERVICE` (ports 80/443) ;
  l’app est uid 10001 sans capability.
- MariaDB official image démarre en root puis descend vers `mysql` ; capabilities
  minimales CHOWN/SETUID/SETGID/FOWNER/DAC_OVERRIDE pour l’entrypoint.
- `docker inspect` peut encore révéler le chemin des fichiers secrets, pas leur
  contenu. Protéger `deploy/secrets/` (700) et ne pas les copier dans l’image.
- Scan d’image / SBOM / pinning des actions GitHub : issue #37.
