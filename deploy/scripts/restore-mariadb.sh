#!/usr/bin/env bash
# Restaure un dump avec l'identité de restauration (pas root, issue #36).
# Usage : ./deploy/scripts/restore-mariadb.sh backups/clubika-AAAA.MM.JJ-HHMMSS.sql.gz

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
DUMP="${1:-}"
RESTORE_USER="${DB_RESTORE_USER:-clubika_restore}"

if [[ -z "$DUMP" || ! -f "$DUMP" ]]; then
  echo "Usage : $0 <dump.sql.gz>" >&2
  exit 1
fi
if [[ -z "${DB_RESTORE_PASSWORD:-}" ]]; then
  echo "DB_RESTORE_PASSWORD manquant (secrets/db_restore_password)" >&2
  exit 1
fi

echo "Restauration de $DUMP avec ${RESTORE_USER}…"
gunzip -c "$DUMP" \
  | docker compose -f "$COMPOSE_FILE" --env-file "${DEPLOY_DIR}/.env" exec -T \
      -e MYSQL_PWD="$DB_RESTORE_PASSWORD" \
      mariadb \
      mariadb --user="$RESTORE_USER"

echo "Dump restauré. Redémarrer l'app : docker compose up -d --force-recreate app"
echo "Remettre la même app_encryption_key qu'au moment du dump."
