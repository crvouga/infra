#!/usr/bin/env bash
# Idempotent node bootstrap — invoked only from GitHub Actions CI.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/chrisvouga}"

echo "==> Bootstrap chrisvouga node (deploy_dir=${DEPLOY_DIR})"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "ERROR: docker compose plugin missing after Docker install"
  exit 1
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow 22/tcp || true
  ufw allow 80/tcp || true
  ufw --force enable || true
fi

mkdir -p "${DEPLOY_DIR}/env"
chown -R root:root "${DEPLOY_DIR}"

UNIT_PATH="/etc/systemd/system/chrisvouga.service"
cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=chrisvouga.dev Docker stack
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=-${DEPLOY_DIR}/.env
ExecStart=/usr/bin/docker compose up -d --remove-orphans
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable chrisvouga.service

echo "==> Bootstrap complete"
