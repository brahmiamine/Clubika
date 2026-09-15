#!/usr/bin/env bash
# Contrôles bloquants avant docker compose up (issue #36).
# Une option non vérifiable sur le VPS (pare-feu hôte) exige une attestation explicite.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${DEPLOY_DIR}/.env"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
SECRETS_DIR="${DEPLOY_DIR}/secrets"

fail() {
  echo "[preflight] $*" >&2
  exit 1
}

[[ -f "$COMPOSE_FILE" ]] || fail "docker-compose.yml manquant"
[[ -f "$ENV_FILE" ]] || fail ".env manquant — copiez .env.production.example"

mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%OLp' "$ENV_FILE")"
if [[ "$mode" != "600" && "$mode" != "400" && "$mode" != "0600" && "$mode" != "0400" ]]; then
  fail "deploy/.env doit être en mode 600 (actuel : $mode)"
fi

# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

[[ "${HOST_FIREWALL_CONFIRMED:-}" == "1" ]] || fail \
  "HOST_FIREWALL_CONFIRMED=1 est obligatoire : attestez que seuls 22/80/443 sont ouverts et que MariaDB n'est pas publiée."

[[ "${APP_BASE_URL:-}" =~ ^https:// ]] || fail "APP_BASE_URL HTTPS est obligatoire en production."

required_secrets=(
  mariadb_root_password
  db_password
  db_backup_password
  db_restore_password
  app_encryption_key
  cron_secret
)
for name in "${required_secrets[@]}"; do
  path="${SECRETS_DIR}/${name}"
  [[ -f "$path" ]] || fail "Secret manquant : secrets/${name}"
  secret_mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%OLp' "$path")"
  if [[ "$secret_mode" != "600" && "$secret_mode" != "400" && "$secret_mode" != "0600" && "$secret_mode" != "0400" ]]; then
    fail "secrets/${name} doit être en mode 600 (actuel : $secret_mode)"
  fi
  [[ -s "$path" ]] || fail "secrets/${name} est vide"
done

secrets_dir_mode="$(stat -c '%a' "$SECRETS_DIR" 2>/dev/null || stat -f '%OLp' "$SECRETS_DIR")"
if [[ "$secrets_dir_mode" != "700" && "$secrets_dir_mode" != "0700" ]]; then
  fail "deploy/secrets/ doit être en mode 700 (actuel : $secrets_dir_mode)"
fi

forbidden_env_keys=(
  DB_PASSWORD
  MARIADB_ROOT_PASSWORD
  APP_ENCRYPTION_KEY
  CRON_SECRET
  DB_BACKUP_PASSWORD
  DB_RESTORE_PASSWORD
  VAPID_PRIVATE_KEY
  SMTP_PASSWORD
  BOOTSTRAP_SUPERADMIN_PASSWORD
  PLATFORM_ADMIN_PASSWORD
)
for key in "${forbidden_env_keys[@]}"; do
  if grep -E "^${key}=" "$ENV_FILE" >/dev/null 2>&1; then
    fail "${key} ne doit pas figurer dans .env (utiliser deploy/secrets/ et *_FILE)."
  fi
done

if grep -E 'image:.*:latest' "$COMPOSE_FILE" >/dev/null 2>&1; then
  fail "Une image :latest est présente dans docker-compose.yml"
fi
if ! grep -E 'mariadb:.*@sha256:' "$COMPOSE_FILE" >/dev/null 2>&1; then
  fail "MariaDB n'est pas pinnée par digest"
fi
if grep -E '^\s+ports:' -A2 "$COMPOSE_FILE" | grep -E '3306' >/dev/null 2>&1; then
  fail "MariaDB ne doit pas publier le port 3306"
fi

app_password="$(tr -d '\r\n' < "${SECRETS_DIR}/db_password")"
root_password="$(tr -d '\r\n' < "${SECRETS_DIR}/mariadb_root_password")"
backup_password="$(tr -d '\r\n' < "${SECRETS_DIR}/db_backup_password")"
restore_password="$(tr -d '\r\n' < "${SECRETS_DIR}/db_restore_password")"
[[ "$app_password" != "$root_password" ]] || fail "db_password et mariadb_root_password doivent être distincts"
[[ "$backup_password" != "$app_password" ]] || fail "db_backup_password doit être distinct du mot de passe applicatif"
[[ "$restore_password" != "$app_password" ]] || fail "db_restore_password doit être distinct du mot de passe applicatif"
[[ "$backup_password" != "$restore_password" ]] || fail "backup et restore doivent avoir des secrets distincts"

for name in "${required_secrets[@]}"; do
  value="$(tr -d '\r\n' < "${SECRETS_DIR}/${name}")"
  if [[ ! "$value" =~ ^[A-Za-z0-9+/=_-]+$ ]]; then
    fail "secrets/${name} : n'utiliser que des caractères [A-Za-z0-9+/=_-] (openssl rand -hex / -base64)"
  fi
done

echo "[preflight] OK — pare-feu attesté, secrets fichiers, images pinnées, MariaDB non publiée."
