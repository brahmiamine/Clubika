#!/usr/bin/env bash
# Installe le crontab Clubika (remplace le crontab de l'utilisateur courant).

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${DEPLOY_DIR}/crontab"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "Fichier manquant : $TEMPLATE" >&2
  exit 1
fi

chmod +x "${DEPLOY_DIR}/scripts/"*.sh

sed "s|__DEPLOY_DIR__|${DEPLOY_DIR}|g" "$TEMPLATE" | crontab -
echo "Cron installé pour ${DEPLOY_DIR} :"
crontab -l
