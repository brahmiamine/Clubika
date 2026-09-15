#!/usr/bin/env bash
# Vérifie qu'une image applicative refuse l'écriture hors tmpfs et n'a pas de cap (issue #36).
# Usage : ./deploy/scripts/assert-runtime-hardening.sh clubika:ci

set -euo pipefail

IMAGE="${1:-}"
if [[ -z "$IMAGE" ]]; then
  echo "Usage : $0 <image>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-runtime-images.sh"

user="$(docker image inspect --format '{{.Config.User}}' "$IMAGE")"
expected="${APP_UID}:${APP_GID}"
if [[ "$user" != "$expected" ]]; then
  echo "USER image = '$user' (attendu $expected)" >&2
  exit 1
fi

id_out="$(docker run --rm --entrypoint id "$IMAGE")"
echo "$id_out"
if ! grep -q "uid=${APP_UID}" <<<"$id_out"; then
  echo "Le processus n'est pas uid ${APP_UID}" >&2
  exit 1
fi

run_locked() {
  docker run --rm \
    --read-only \
    --tmpfs /tmp:size=32m \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --user "${APP_UID}:${APP_GID}" \
    --entrypoint "$1" \
    "$IMAGE" \
    "${@:2}"
}

if run_locked touch /app/should-not-exist; then
  echo "Écriture imprévue sur /app autorisée" >&2
  exit 1
fi

run_locked sh -c 'touch /tmp/ok && test -f /tmp/ok'

caps="$(docker run --rm \
  --read-only \
  --tmpfs /tmp \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --user "${APP_UID}:${APP_GID}" \
  --entrypoint cat \
  "$IMAGE" \
  /proc/1/status | awk '/^CapEff:/{print $2}')"
if [[ "$caps" != "0000000000000000" ]]; then
  echo "CapEff=$caps (attendu 0 après cap_drop ALL)" >&2
  exit 1
fi

echo "Runtime hardening OK pour $IMAGE (non-root ${expected}, read-only, cap_drop ALL)."
