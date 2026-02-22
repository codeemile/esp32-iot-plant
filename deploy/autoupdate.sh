#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="/tmp/esp32-iot-plant-autoupdate.lock"

if ! command -v git >/dev/null 2>&1; then
  echo "[auto-update] git est requis" >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "[auto-update] docker compose est requis" >&2
  exit 1
fi

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[auto-update] Une execution est deja en cours, abandon."
  exit 0
fi

cd "$REPO_DIR"

DEFAULT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BRANCH="${AUTOUPDATE_BRANCH:-$DEFAULT_BRANCH}"
REMOTE_NAME="${AUTOUPDATE_REMOTE:-origin}"
COMPOSE_FILE="${AUTOUPDATE_COMPOSE_FILE:-docker-compose.yml}"
PRUNE_IMAGES="${AUTOUPDATE_PRUNE_IMAGES:-0}"

echo "[auto-update] Check updates sur $REMOTE_NAME/$BRANCH"
git fetch --prune "$REMOTE_NAME" "$BRANCH"

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "$REMOTE_NAME/$BRANCH")"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  echo "[auto-update] Aucun changement detecte"
  exit 0
fi

echo "[auto-update] Nouveau commit detecte: $LOCAL_SHA -> $REMOTE_SHA"
git pull --ff-only "$REMOTE_NAME" "$BRANCH"

echo "[auto-update] Rebuild et relance des conteneurs"
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d --build --remove-orphans

if [[ "$PRUNE_IMAGES" == "1" ]]; then
  echo "[auto-update] Nettoyage images Docker inutilisees"
  docker image prune -f
fi

echo "[auto-update] Termine"
