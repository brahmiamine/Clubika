#!/usr/bin/env bash
# Rafraîchit les digests immuables (issue #36).
# Usage : ./deploy/scripts/refresh-image-pins.sh
# Puis relancer pnpm test -- deploy/runtime-hardening.test.ts et relire le diff.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-runtime-images.sh"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LOCK_FILE="${SCRIPT_DIR}/../runtime-images.lock"

digest_for() {
  local repo="$1"
  local tag="$2"
  local token
  token="$(curl -fsSL "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')"
  curl -fsSI \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json" \
    "https://registry-1.docker.io/v2/${repo}/manifests/${tag}" \
    | tr -d '\r' \
    | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2; exit}'
}

tag_of() {
  local image="$1"
  local without_digest="${image%%@*}"
  echo "${without_digest#*:}"
}

repo_of() {
  local image="$1"
  local without_digest="${image%%@*}"
  echo "library/${without_digest%%:*}"
}

update_pin() {
  local var_name="$1"
  local current="${!var_name}"
  local repo tag digest
  repo="$(repo_of "$current")"
  tag="$(tag_of "$current")"
  echo "Résolution ${repo}:${tag}…" >&2
  digest="$(digest_for "$repo" "$tag")"
  if [[ -z "$digest" || "$digest" != sha256:* ]]; then
    echo "Impossible de résoudre le digest de ${repo}:${tag}" >&2
    exit 1
  fi
  echo "${current%%@*}@${digest}"
}

NEW_NODE="$(update_pin NODE_IMAGE)"
NEW_MARIADB="$(update_pin MARIADB_IMAGE)"
NEW_CADDY="$(update_pin CADDY_IMAGE)"
NEW_PMA="$(update_pin PHPMYADMIN_IMAGE)"

cat > "$LOCK_FILE" <<EOF
# Pins immuables des images runtime (issue #36).
# Ne jamais utiliser :latest. Mettre à jour : ./deploy/scripts/refresh-image-pins.sh
# Puis relancer les tests \`deploy/runtime-hardening.test.ts\`.

NODE_IMAGE=${NEW_NODE}
MARIADB_IMAGE=${NEW_MARIADB}
CADDY_IMAGE=${NEW_CADDY}
PHPMYADMIN_IMAGE=${NEW_PMA}
APP_UID=${APP_UID}
APP_GID=${APP_GID}
EOF

replace_all() {
  local old="$1"
  local new="$2"
  grep -rlF -- "$old" "$ROOT_DIR/Dockerfile" "$ROOT_DIR/deploy" "$ROOT_DIR/.github" "$ROOT_DIR/start.sh" \
    | while IFS= read -r file; do
      python3 - "$file" "$old" "$new" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
old, new = sys.argv[2], sys.argv[3]
text = path.read_text()
path.write_text(text.replace(old, new))
PY
    done
}

replace_all "$NODE_IMAGE" "$NEW_NODE"
replace_all "$MARIADB_IMAGE" "$NEW_MARIADB"
replace_all "$CADDY_IMAGE" "$NEW_CADDY"
replace_all "$PHPMYADMIN_IMAGE" "$NEW_PMA"

echo "Pins mis à jour dans $LOCK_FILE"
echo "Vérifiez le diff puis committez avec les tests de durcissement."
