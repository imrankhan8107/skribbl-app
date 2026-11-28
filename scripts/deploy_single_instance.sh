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

# Ensure local iptables allow WebRTC TURN/STUN ports
iptables -C INPUT -p tcp --dport 3478 -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport 3478 -j ACCEPT || true
iptables -C INPUT -p udp --dport 3478 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 3478 -j ACCEPT || true
iptables -C INPUT -p udp --dport 49152:49200 -j ACCEPT 2>/dev/null || iptables -I INPUT -p udp --dport 49152:49200 -j ACCEPT || true

# Ensure self-hosted coturn TURN relay is running for mobile CGNAT WebRTC voice
TURN_ENV_FILE="/etc/skribbl-turn.env"
PUBLIC_IP=$(curl -fsS --max-time 5 https://api.ipify.org || curl -fsS --max-time 5 https://ifconfig.me || echo "")
if [ -n "$PUBLIC_IP" ]; then
  if [ ! -f "$TURN_ENV_FILE" ]; then
    TURN_PASS=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
    cat <<EOF > "$TURN_ENV_FILE"
TURN_URLS=turn:${PUBLIC_IP}:3478?transport=udp,turn:${PUBLIC_IP}:3478?transport=tcp
TURN_USERNAME=skribbl
TURN_CREDENTIAL=${TURN_PASS}
EOF
    chmod 600 "$TURN_ENV_FILE"
  fi

  # shellcheck disable=SC1090
  source "$TURN_ENV_FILE"

  if ! docker ps --format '{{.Names}}' | grep -q '^skribbl-coturn$'; then
    docker rm -f skribbl-coturn >/dev/null 2>&1 || true
    docker run -d \
      --name skribbl-coturn \
      --restart always \
      --network host \
      coturn/coturn:latest \
      -n \
      --log-file=stdout \
      --listening-port=3478 \
      --min-port=49152 \
      --max-port=49200 \
      --lt-cred-mech \
      --realm=skribbl-app.duckdns.org \
      --user="${TURN_USERNAME}:${TURN_CREDENTIAL}" \
      --external-ip="${PUBLIC_IP}" \
      --no-cli || true
  fi
fi

docker build -t skribbl-app .

# Preserve HTTPS Nginx reverse-proxy binding if Nginx is active on port 80
if systemctl is-active --quiet nginx; then
  PORT_FLAGS="-p 127.0.0.1:8000:8000 -p 9000:8000"
else
  PORT_FLAGS="-p 80:8000 -p 9000:8000"
fi

TURN_ENV_FLAG=""
if [ -f "$TURN_ENV_FILE" ]; then
  TURN_ENV_FLAG="--env-file $TURN_ENV_FILE"
fi

docker stop skribbl >/dev/null 2>&1 || true
docker rm skribbl >/dev/null 2>&1 || true

# shellcheck disable=SC2086
docker run -d \
  --name skribbl \
  --restart always \
  $PORT_FLAGS \
  $TURN_ENV_FLAG \
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
