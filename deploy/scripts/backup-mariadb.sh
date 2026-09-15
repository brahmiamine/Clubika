#!/usr/bin/env bash
# Dump quotidien MariaDB avec l'identité de sauvegarde (issue #36).
# Conservez aussi une copie hors VPS de deploy/secrets/app_encryption_key
# (la clé n'est pas dans le dump).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

BACKUP_DIR="${DEPLOY_DIR}/backups"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/clubika-${STAMP}.sql.gz"
BACKUP_USER="${DB_BACKUP_USER:-clubika_backup}"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [[ -z "${DB_BACKUP_PASSWORD:-}" || -z "${DB_NAME:-}" ]]; then
  echo "DB_BACKUP_PASSWORD / DB_NAME manquants (secrets/ + .env)" >&2
  exit 1
fi

docker compose -f "$COMPOSE_FILE" --env-file "${DEPLOY_DIR}/.env" exec -T \
  -e MYSQL_PWD="$DB_BACKUP_PASSWORD" \
  mariadb \
  mariadb-dump \
    --user="$BACKUP_USER" \
    --single-transaction \
    --routines \
    --databases "$DB_NAME" \
  | gzip -c > "$OUT"

chmod 600 "$OUT"

if [[ ! -s "$OUT" ]]; then
  echo "Dump vide : $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

find "$BACKUP_DIR" -type f -name 'clubika-*.sql.gz' -mtime "+${KEEP_DAYS}" -delete

echo "Sauvegarde écrite : $OUT"
echo "Rappel : copiez aussi deploy/secrets/ (clé de chiffrement) hors de ce VPS."
