#!/bin/bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/skribbl-app}"
BRANCH="${GIT_BRANCH:-master}"
FORCE="${1:-}"

cd "$APP_DIR"

git fetch origin "$BRANCH" --quiet
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ] && [ "$FORCE" != "--force" ]; then
  exit 0
fi

echo "=== Deploying $BRANCH ($LOCAL_SHA -> $REMOTE_SHA) at $(date) ==="
git pull --ff-only origin "$BRANCH"

docker build -t skribbl-app .

# Preserve HTTPS Nginx reverse-proxy binding if Nginx is active on port 80
if systemctl is-active --quiet nginx; then
  PORT_FLAGS="-p 127.0.0.1:8000:8000 -p 9000:8000"
else
  PORT_FLAGS="-p 80:8000 -p 9000:8000"
fi

docker stop skribbl >/dev/null 2>&1 || true
docker rm skribbl >/dev/null 2>&1 || true

# shellcheck disable=SC2086
docker run -d \
  --name skribbl \
  --restart always \
  $PORT_FLAGS \
  -e PORT=8000 \
  skribbl-app

# Verify container health
for i in $(seq 1 15); do
  if curl -fsS http://127.0.0.1:9000/health >/dev/null 2>&1; then
    echo "=== Deployment healthy at $(date) ==="
    docker image prune -f >/dev/null 2>&1 || true
    exit 0
  fi
  sleep 2
done

echo "Warning: /health check did not respond within 30s"
docker logs --tail 30 skribbl || true
exit 1
