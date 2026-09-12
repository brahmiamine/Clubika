#!/usr/bin/env bash
# Appelle une route cron Clubika via l'app bindée sur 127.0.0.1:3000.
# Usage : cron-hit.sh planning-reminders | scraper

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/load-env.sh"

ROUTE="${1:-}"
case "$ROUTE" in
  planning-reminders|scraper) ;;
  *)
    echo "Usage : $0 planning-reminders|scraper" >&2
    exit 1
    ;;
esac

if [[ -z "${CRON_SECRET:-}" ]]; then
  echo "CRON_SECRET est vide dans deploy/.env" >&2
  exit 1
fi

curl --fail --silent --show-error \
  --request POST \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  --max-time 300 \
  "http://127.0.0.1:3000/api/cron/${ROUTE}"
echo
