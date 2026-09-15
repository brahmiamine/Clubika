#!/usr/bin/env bash
# Identités SQL séparées pour dump / restauration (issue #36).
# À lancer après le premier démarrage MariaDB (update.sh le fait).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
SECRETS_DIR="${DEPLOY_DIR}/secrets"
DB_NAME="${DB_NAME:-clubika}"
BACKUP_USER="${DB_BACKUP_USER:-clubika_backup}"
RESTORE_USER="${DB_RESTORE_USER:-clubika_restore}"

[[ -f "${SECRETS_DIR}/mariadb_root_password" ]] || {
  echo "secrets/mariadb_root_password manquant" >&2
  exit 1
}
[[ -f "${SECRETS_DIR}/db_backup_password" ]] || {
  echo "secrets/db_backup_password manquant" >&2
  exit 1
}
[[ -f "${SECRETS_DIR}/db_restore_password" ]] || {
  echo "secrets/db_restore_password manquant" >&2
  exit 1
}

ROOT_PASSWORD="$(tr -d '\r\n' < "${SECRETS_DIR}/mariadb_root_password")"
BACKUP_PASSWORD="$(tr -d '\r\n' < "${SECRETS_DIR}/db_backup_password")"
RESTORE_PASSWORD="$(tr -d '\r\n' < "${SECRETS_DIR}/db_restore_password")"

sql="$(printf '%s\n' \
  "CREATE USER IF NOT EXISTS '${BACKUP_USER}'@'%' IDENTIFIED BY '${BACKUP_PASSWORD}';" \
  "ALTER USER '${BACKUP_USER}'@'%' IDENTIFIED BY '${BACKUP_PASSWORD}';" \
  "GRANT SELECT, LOCK TABLES, SHOW VIEW, TRIGGER, EVENT ON \`${DB_NAME}\`.* TO '${BACKUP_USER}'@'%';" \
  "GRANT SHOW ROUTINE ON *.* TO '${BACKUP_USER}'@'%';" \
  "CREATE USER IF NOT EXISTS '${RESTORE_USER}'@'%' IDENTIFIED BY '${RESTORE_PASSWORD}';" \
  "ALTER USER '${RESTORE_USER}'@'%' IDENTIFIED BY '${RESTORE_PASSWORD}';" \
  "GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, INDEX, ALTER, REFERENCES, CREATE VIEW, SHOW VIEW, TRIGGER, EVENT, CREATE ROUTINE, ALTER ROUTINE ON \`${DB_NAME}\`.* TO '${RESTORE_USER}'@'%';" \
  "FLUSH PRIVILEGES;"
)"

docker compose -f "$COMPOSE_FILE" --env-file "${DEPLOY_DIR}/.env" exec -T \
  -e MYSQL_PWD="$ROOT_PASSWORD" \
  mariadb \
  mariadb -uroot <<<"$sql"

echo "Identités SQL ${BACKUP_USER} (dump) et ${RESTORE_USER} (restauration) à jour."
