#!/usr/bin/env bash
# Charge deploy/.env et les fichiers deploy/secrets/* pour les scripts hôte (issue #36).

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
SECRETS_DIR="${DEPLOY_DIR}/secrets"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Fichier manquant : $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

load_secret() {
  local var_name="$1"
  local file_name="$2"
  local path="${SECRETS_DIR}/${file_name}"
  if [[ -f "$path" ]]; then
    export "${var_name}=$(tr -d '\r\n' < "$path")"
  fi
}

load_secret DB_PASSWORD db_password
load_secret MARIADB_ROOT_PASSWORD mariadb_root_password
load_secret APP_ENCRYPTION_KEY app_encryption_key
load_secret BACKUP_ENCRYPTION_KEY backup_encryption_key
load_secret CRON_SECRET cron_secret
load_secret DB_BACKUP_PASSWORD db_backup_password
load_secret DB_RESTORE_PASSWORD db_restore_password
load_secret VAPID_PRIVATE_KEY vapid_private_key
load_secret SMTP_PASSWORD smtp_password
load_secret BOOTSTRAP_SUPERADMIN_PASSWORD bootstrap_superadmin_password
load_secret PLATFORM_ADMIN_PASSWORD platform_admin_password

DB_BACKUP_USER="${DB_BACKUP_USER:-clubika_backup}"
DB_RESTORE_USER="${DB_RESTORE_USER:-clubika_restore}"
export DB_BACKUP_USER DB_RESTORE_USER
