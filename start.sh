#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

MARIADB_IMAGE="${MARIADB_IMAGE:-mariadb:latest}"
PHPMYADMIN_IMAGE="${PHPMYADMIN_IMAGE:-phpmyadmin:latest}"

DB_CONTAINER="${DB_CONTAINER:-afp_mariadb}"
PMA_CONTAINER="${PMA_CONTAINER:-afp_phpmyadmin}"
DOCKER_NETWORK="${DOCKER_NETWORK:-afp_network}"

DB_NAME="${DB_NAME:-clubika}"
DB_USER="${DB_USER:-clubika_user}"
DB_PASSWORD="${DB_PASSWORD:-clubika_password}"
DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-root_password}"

DB_PORT="${DB_PORT:-3306}"
PMA_PORT="${PMA_PORT:-8080}"

APP_CMD="${APP_CMD:-}"

log() {
  echo "[start.sh] $*"
}

err() {
  echo "[start.sh][ERREUR] $*" >&2
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    err "La commande '$command_name' est introuvable."
    exit 1
  fi
}

wait_for_docker() {
  local retries=30
  local delay=2

  for ((i=1; i<=retries; i++)); do
    if docker info >/dev/null 2>&1; then
      return 0
    fi
    sleep "$delay"
  done

  return 1
}

ensure_docker_running() {
  require_command docker

  if docker info >/dev/null 2>&1; then
    log "Docker est déjà démarré."
    return
  fi

  log "Docker n'est pas actif. Tentative de démarrage..."

  if [[ "$(uname -s)" == "Darwin" ]]; then
    if ! open -a Docker >/dev/null 2>&1; then
      err "Impossible d'ouvrir Docker Desktop automatiquement."
      exit 1
    fi
  else
    err "Docker n'est pas démarré. Lance le daemon Docker puis relance ce script."
    exit 1
  fi

  if ! wait_for_docker; then
    err "Docker ne répond pas après plusieurs tentatives."
    exit 1
  fi

  log "Docker est opérationnel."
}

ensure_image() {
  local image_name="$1"
  log "Mise à jour de l'image (latest): $image_name"
  docker pull "$image_name" >/dev/null
}

ensure_network() {
  if docker network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
    log "Réseau Docker déjà présent: $DOCKER_NETWORK"
  else
    log "Création du réseau Docker: $DOCKER_NETWORK"
    docker network create "$DOCKER_NETWORK" >/dev/null
  fi
}

container_exists() {
  local container_name="$1"
  docker ps -a --format '{{.Names}}' | grep -Fxq "$container_name"
}

container_running() {
  local container_name="$1"
  docker ps --format '{{.Names}}' | grep -Fxq "$container_name"
}

ensure_mariadb_container() {
  if container_exists "$DB_CONTAINER"; then
    if container_running "$DB_CONTAINER"; then
      log "Conteneur MariaDB déjà en cours: $DB_CONTAINER"
    else
      log "Démarrage du conteneur MariaDB existant: $DB_CONTAINER"
      docker start "$DB_CONTAINER" >/dev/null
    fi
    return
  fi

  log "Création du conteneur MariaDB: $DB_CONTAINER"
  docker run -d \
    --name "$DB_CONTAINER" \
    --network "$DOCKER_NETWORK" \
    -p "$DB_PORT":3306 \
    -e MARIADB_ROOT_PASSWORD="$DB_ROOT_PASSWORD" \
    -e MARIADB_DATABASE="$DB_NAME" \
    -e MARIADB_USER="$DB_USER" \
    -e MARIADB_PASSWORD="$DB_PASSWORD" \
    "$MARIADB_IMAGE" >/dev/null
}

ensure_phpmyadmin_container() {
  if container_exists "$PMA_CONTAINER"; then
    if container_running "$PMA_CONTAINER"; then
      log "Conteneur phpMyAdmin déjà en cours: $PMA_CONTAINER"
    else
      log "Démarrage du conteneur phpMyAdmin existant: $PMA_CONTAINER"
      docker start "$PMA_CONTAINER" >/dev/null
    fi
    return
  fi

  log "Création du conteneur phpMyAdmin: $PMA_CONTAINER"
  docker run -d \
    --name "$PMA_CONTAINER" \
    --network "$DOCKER_NETWORK" \
    -p "$PMA_PORT":80 \
    -e PMA_HOST="$DB_CONTAINER" \
    -e PMA_PORT=3306 \
    "$PHPMYADMIN_IMAGE" >/dev/null
}

detect_app_command() {
  if [[ -n "$APP_CMD" ]]; then
    echo "$APP_CMD"
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    echo "pnpm run dev:app"
    return
  fi

  if command -v npm >/dev/null 2>&1; then
    echo "npm run dev:app"
    return
  fi

  err "Ni pnpm ni npm n'est disponible pour lancer l'application."
  exit 1
}

ensure_node_modules() {
  if [[ -d node_modules ]]; then
    return
  fi

  if command -v pnpm >/dev/null 2>&1; then
    log "Installation des dépendances via pnpm..."
    pnpm install
    return
  fi

  log "Installation des dépendances via npm..."
  npm install
}

wait_for_mariadb_ready() {
  local retries=60
  local delay=1

  log "Attente que MariaDB accepte les connexions..."
  for ((i=1; i<=retries; i++)); do
    if docker exec "$DB_CONTAINER" mariadb-admin ping \
        -h 127.0.0.1 -u "$DB_USER" -p"$DB_PASSWORD" --silent >/dev/null 2>&1; then
      log "MariaDB est prêt."
      return 0
    fi
    sleep "$delay"
  done

  err "MariaDB ne répond pas après ${retries}s. Vérifie les logs: docker logs $DB_CONTAINER"
  exit 1
}

main() {
  log "Vérification de Docker..."
  ensure_docker_running

  log "Vérification des images Docker..."
  ensure_image "$MARIADB_IMAGE"
  ensure_image "$PHPMYADMIN_IMAGE"

  log "Vérification de l'infrastructure Docker..."
  ensure_network
  ensure_mariadb_container
  ensure_phpmyadmin_container

  wait_for_mariadb_ready

  log "MariaDB:   mysql://$DB_USER:$DB_PASSWORD@localhost:$DB_PORT/$DB_NAME"
  log "phpMyAdmin: http://localhost:$PMA_PORT"

  ensure_node_modules

  local app_command
  app_command="$(detect_app_command)"
  log "Lancement de l'application: $app_command"
  exec $app_command
}

main "$@"