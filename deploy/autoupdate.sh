#!/usr/bin/env bash
set -Eeuo pipefail

export PATH="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_FILE="/tmp/esp32-iot-plant-autoupdate.lock"

if ! command -v git >/dev/null 2>&1; then
  echo "[auto-update] git est requis" >&2
  exit 1
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "[auto-update] flock est requis (package util-linux)" >&2
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
git fetch --prune "$REMOTE_NAME"

REMOTE_REF="refs/remotes/$REMOTE_NAME/$BRANCH"
if ! git show-ref --verify --quiet "$REMOTE_REF"; then
  echo "[auto-update] Branche distante introuvable: $REMOTE_NAME/$BRANCH" >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "$BRANCH" ]]; then
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git checkout "$BRANCH"
  else
    git checkout -B "$BRANCH" --track "$REMOTE_NAME/$BRANCH"
  fi
fi

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse "$REMOTE_REF")"

if [[ "$LOCAL_SHA" == "$REMOTE_SHA" ]]; then
  echo "[auto-update] Aucun changement detecte"
  exit 0
fi

echo "[auto-update] Nouveau commit detecte: $LOCAL_SHA -> $REMOTE_SHA"
git merge --ff-only "$REMOTE_REF"

echo "[auto-update] Rebuild et relance des conteneurs"
"${COMPOSE_CMD[@]}" -f "$COMPOSE_FILE" up -d --build --remove-orphans

if [[ "$PRUNE_IMAGES" == "1" ]]; then
  echo "[auto-update] Nettoyage images Docker inutilisees"
  docker image prune -f
fi

echo "[auto-update] Termine"
