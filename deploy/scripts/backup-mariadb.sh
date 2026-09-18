#!/usr/bin/env bash
# Dump quotidien MariaDB chiffré (AES-256-GCM, issue #24) avec l'identité
# de sauvegarde (issue #36). Conservez deploy/secrets/ hors VPS : la clé
# applicative et BACKUP_ENCRYPTION_KEY ne sont pas dans le dump.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

BACKUP_DIR="${DEPLOY_DIR}/backups"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.yml"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${BACKUP_DIR}/clubika-${STAMP}.sql.gz.enc"
SHA="${OUT}.sha256"
PLAIN_TMP="$(mktemp)"
BACKUP_USER="${DB_BACKUP_USER:-clubika_backup}"

cleanup() {
  rm -f "$PLAIN_TMP"
}
trap cleanup EXIT

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

if [[ -z "${DB_BACKUP_PASSWORD:-}" || -z "${DB_NAME:-}" ]]; then
  echo "DB_BACKUP_PASSWORD / DB_NAME manquants (secrets/ + .env)" >&2
  exit 1
fi

if [[ -z "${BACKUP_ENCRYPTION_KEY:-}" ]]; then
  echo "BACKUP_ENCRYPTION_KEY manquant : refus d’écrire un dump en clair." >&2
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
  | gzip -c > "$PLAIN_TMP"

if [[ ! -s "$PLAIN_TMP" ]]; then
  echo "Dump vide" >&2
  exit 1
fi

FINGERPRINT_FILE="$(mktemp)"
docker compose -f "$COMPOSE_FILE" --env-file "${DEPLOY_DIR}/.env" exec -T \
  -e BACKUP_ENCRYPTION_KEY="$BACKUP_ENCRYPTION_KEY" \
  -e BACKUP_ENCRYPTION_KEY_ID="${BACKUP_ENCRYPTION_KEY_ID:-b1}" \
  app \
  pnpm exec tsx deploy/scripts/backup-box-cli.ts encrypt \
  < "$PLAIN_TMP" > "$OUT" 2>"$FINGERPRINT_FILE"

FINGERPRINT="$(tr -d '[:space:]' < "$FINGERPRINT_FILE")"
rm -f "$FINGERPRINT_FILE"

chmod 600 "$OUT"

if [[ ! -s "$OUT" ]]; then
  echo "Chiffrement vide : $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

printf '%s  %s\n' "$FINGERPRINT" "$(basename "$OUT")" > "$SHA"

find "$BACKUP_DIR" -type f \( -name 'clubika-*.sql.gz.enc' -o -name 'clubika-*.sql.gz.enc.sha256' -o -name 'clubika-*.sql.gz' \) -mtime "+${KEEP_DAYS}" -delete

echo "Sauvegarde chiffrée : $OUT"
echo "Empreinte SHA-256 : $SHA"
echo "Rappel : copiez aussi deploy/secrets/ (app_encryption_key et backup_encryption_key) hors de ce VPS."
