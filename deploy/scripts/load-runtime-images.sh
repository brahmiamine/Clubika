#!/usr/bin/env bash
# Charge deploy/runtime-images.lock (issue #36).

set -euo pipefail

LOCK_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/runtime-images.lock"

if [[ ! -f "$LOCK_FILE" ]]; then
  echo "Fichier manquant : $LOCK_FILE" >&2
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  export "$key=$value"
done < "$LOCK_FILE"
