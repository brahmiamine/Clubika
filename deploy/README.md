# Déploiement VPS (OVH, Debian, clubika.com)

Une instance de l’app, MariaDB, Caddy (HTTPS). Pas de réplicas : le chat
est conçu pour un seul processus.

## 1. DNS et pare-feu

Chez le registrar : enregistrement **A** `clubika.com` et `www` vers l’IP du VPS.
Ouvrir uniquement **22**, **80** et **443**.

Attendre que le DNS réponde avant `docker compose up` : Caddy demande le
certificat Let’s Encrypt tout de suite.

## 2. Docker

Sur Debian 13, installer le moteur Docker et le plugin Compose v2
(dépôt Docker officiel). Puis cloner le dépôt, par exemple dans `/opt/clubika`.

## 3. Secrets

```bash
cd /opt/clubika/deploy
cp .env.production.example .env
```

Remplir `.env` :

- `DB_PASSWORD` et `MARIADB_ROOT_PASSWORD` (longs, distincts)
- `APP_ENCRYPTION_KEY`, `BACKUP_ENCRYPTION_KEY` et `CRON_SECRET` : `openssl rand -hex 32`
  (`BACKUP_ENCRYPTION_KEY` **distincte** de la clé applicative)
- mots de passe bootstrap admin club et `/plateforme`
- clés VAPID : `node scripts/generate-vapid-keys.mjs` depuis la racine du dépôt,
  puis coller `NEXT_PUBLIC_VAPID_PUBLIC_KEY` aussi dans `VAPID_PUBLIC_KEY`
- SMTP si vous voulez les e-mails

Sauvegardez `.env` **hors du VPS**, séparément des dumps. Les clés de chiffrement
ne sont pas dans MariaDB : les perdre rend les messages `enc:v2` illisibles.

## 4. Lancer

```bash
cd /opt/clubika/deploy
docker compose up -d --build
```

Le premier build est long (Chromium pour le scraper). L’app migrate puis écoute
sur `127.0.0.1:3000`. Caddy expose `https://clubika.com`.

Vérifier : `docker compose ps` et ouvrir le site. Se connecter une fois avec les
comptes bootstrap, **puis retirer les 4 variables `BOOTSTRAP_*` / `PLATFORM_ADMIN_*`
de `.env`** et `docker compose up -d --force-recreate app`.

## 5. Cron et dumps

```bash
sudo timedatectl set-timezone Europe/Paris
./scripts/install-cron.sh
```

Cela installe (crontab utilisateur) :

- relances planning chaque heure à :15
- scraper 7h / 12h / 18h
- dump MariaDB quotidien à 3h20 dans `deploy/backups/` (14 jours), **chiffré**
  AES-256-GCM (`.sql.gz.enc` + `.sha256`). Sans `BACKUP_ENCRYPTION_KEY` le job refuse
  d’écrire un dump en clair.

La sauvegarde OVH « 1 jour » ne remplace pas ces dumps. Copiez les `.enc` **et**
`.env` (clés) sur des supports **séparés**.

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

## 6. Mise à jour

```bash
/opt/clubika/deploy/scripts/update.sh
```

Équivalent manuel : `git pull` de `prod` puis `docker compose up -d --build` dans
`deploy/`. Les migrations passent au démarrage du conteneur `app`. Une seule
instance `app`.

## 7. Restaurer un dump

```bash
./scripts/restore-mariadb.sh --verify backups/clubika-….sql.gz.enc
# environnement isolé :
./scripts/restore-mariadb.sh --restore backups/clubika-….sql.gz.enc
```

Puis redémarrer `app`. Remettre **la même** `APP_ENCRYPTION_KEY` (et
`APP_ENCRYPTION_PREVIOUS_KEYS` si une rotation était en cours) qu’au moment du dump.

## 8. Déploiement automatique (GitHub → VPS)

Chaque **push** ou **merge de PR** sur la branche `prod` (et un lancement manuel
« Run workflow ») SSH sur le VPS, `git pull` puis `docker compose up -d --build`.

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
