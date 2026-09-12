#!/usr/bin/env bash
# Dump quotidien MariaDB. Conservez aussi une copie hors VPS de deploy/.env
# (APP_ENCRYPTION_KEY n'est pas dans le dump).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

BACKUP_DIR="${DEPLOY_DIR}/backups"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/clubika-${STAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

if [[ -z "${DB_USER:-}" || -z "${DB_PASSWORD:-}" || -z "${DB_NAME:-}" ]]; then
  echo "DB_USER / DB_PASSWORD / DB_NAME manquants dans deploy/.env" >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" --env-file "${DEPLOY_DIR}/.env" exec -T \
  -e MYSQL_PWD="$DB_PASSWORD" \
  mariadb \
  mariadb-dump \
    --user="$DB_USER" \
    --single-transaction \
    --routines \
    --databases "$DB_NAME" \
  | gzip -c > "$OUT"

if [[ ! -s "$OUT" ]]; then
  echo "Dump vide : $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

find "$BACKUP_DIR" -type f -name 'clubika-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete

echo "Sauvegarde écrite : $OUT"
echo "Rappel : copiez aussi deploy/.env (clé de chiffrement) hors de ce VPS."
