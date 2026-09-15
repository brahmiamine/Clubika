#!/usr/bin/env bash
# Restauration / preuve de restauration d’un dump AEAD (issue #24).
#   ./restore-mariadb.sh --verify backups/clubika-….sql.gz.enc
#   ./restore-mariadb.sh --restore backups/clubika-….sql.gz.enc
#
# --verify : empreinte + déchiffrement + gzip -t + en-tête SQL, sans toucher MariaDB.
# --restore : même contrôles puis import (environnement isolé recommandé).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
MODE="${1:-}"
ENC_FILE="${2:-}"

if [[ "$MODE" != "--verify" && "$MODE" != "--restore" ]]; then
  echo "Usage : $0 --verify|--restore <fichier.sql.gz.enc>" >&2
  exit 1
fi

if [[ -z "$ENC_FILE" || ! -f "$ENC_FILE" ]]; then
  echo "Fichier de sauvegarde manquant" >&2
  exit 1
fi

if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
  echo "BACKUP_ENCRYPTION_KEY manquant" >&2
  exit 1
fi

SHA_FILE="${ENC_FILE}.sha256"
if [[ -f "$SHA_FILE" ]]; then
  expected="$(awk '{print $1}' "$SHA_FILE")"
  actual="$(sha256sum "$ENC_FILE" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "Empreinte SHA-256 invalide" >&2
    exit 1
  fi
else
  echo "Avertissement : pas de fichier .sha256, contrôle d’intégrité ignoré." >&2
fi

PLAIN_TMP="$(mktemp)"
cleanup() { rm -f "$PLAIN_TMP"; }
trap cleanup EXIT

docker compose -f "$COMPOSE_FILE" --env-file "${DEPLOY_DIR}/.env" exec -T \
  -e BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" \
  app \
  pnpm exec tsx deploy/scripts/backup-box-cli.ts decrypt \
  < "$ENC_FILE" > "$PLAIN_TMP"

gzip -t "$PLAIN_TMP"
if ! gzip -dc "$PLAIN_TMP" | head -c 64 | grep -q "MariaDB\|MySQL dump\|Dump completed\|--"; then
  echo "Le dump déchiffré ne ressemble pas à un export SQL" >&2
  exit 1
fi

echo "Preuve : empreinte OK, AEAD OK, gzip OK, en-tête SQL OK."

if [[ "$MODE" == "--verify" ]]; then
  exit 0
fi

if [[ -z "${MARIADB_ROOT_PASSWORD:-}" ]]; then
  echo "MARIADB_ROOT_PASSWORD manquant pour --restore" >&2
  exit 1
fi

gzip -dc "$PLAIN_TMP" | docker compose -f "$COMPOSE_FILE" --env-file "${DEPLOY_DIR}/.env" exec -T \
  -e MYSQL_PWD="$MARIADB_ROOT_PASSWORD" \
  mariadb \
  mariadb -uroot

echo "Import terminé. Redémarrer app et conserver APP_ENCRYPTION_KEY de l’époque du dump (plus PREVIOUS_KEYS si rotation)."
