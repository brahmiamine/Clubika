#!/usr/bin/env bash
# Mise à jour production sur le VPS : pull de `prod`, préflight, rebuild Compose.
# Utilisé par GitHub Actions (.github/workflows/deploy-prod.yml) et en SSH manuel.

set -euo pipefail

export GIT_TERMINAL_PROMPT=0

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

git fetch origin
git checkout prod
git pull --ff-only origin prod

chmod +x "$ROOT_DIR/deploy/scripts/"*.sh
"$ROOT_DIR/deploy/scripts/preflight.sh"

cd "$ROOT_DIR/deploy"
docker compose up -d --build
"$ROOT_DIR/deploy/scripts/ensure-db-identities.sh"
docker compose ps

echo "Déploiement terminé : $(git -C "$ROOT_DIR" rev-parse --short HEAD)"
echo "Rollback : git -C $ROOT_DIR checkout <sha> && $ROOT_DIR/deploy/scripts/update.sh"
