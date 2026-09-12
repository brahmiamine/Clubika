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
- `APP_ENCRYPTION_KEY` et `CRON_SECRET` : `openssl rand -hex 32`
- mots de passe bootstrap admin club et `/plateforme`
- clés VAPID : `node scripts/generate-vapid-keys.mjs` depuis la racine du dépôt,
  puis coller `NEXT_PUBLIC_VAPID_PUBLIC_KEY` aussi dans `VAPID_PUBLIC_KEY`
- SMTP si vous voulez les e-mails

Sauvegardez `.env` **hors du VPS**. La clé de chiffrement n’est pas dans MariaDB :
la perdre rend les messages de chat déjà chiffrés illisibles.

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
- dump MariaDB quotidien à 3h20 dans `deploy/backups/` (14 jours)

La sauvegarde OVH « 1 jour » ne remplace pas ces dumps. Copiez aussi les `.sql.gz`
et `.env` ailleurs.

Ne pas activer le schedule GitHub Actions des relances si ce cron tourne déjà
(doublon). Voir `PLANNING_REMINDERS.md`.

## 6. Mise à jour

```bash
cd /opt/clubika
git pull
cd deploy
docker compose up -d --build
```

Les migrations passent au démarrage du conteneur `app`. Une seule instance `app`.

## 7. Restaurer un dump

```bash
gunzip -c backups/clubika-AAAA.MM.JJ-HHMMSS.sql.gz \
  | docker compose exec -T -e MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb \
    mariadb -uroot
```

Puis redémarrer `app`. Remettre **la même** `APP_ENCRYPTION_KEY` qu’au moment
du dump.
