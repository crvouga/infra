#!/usr/bin/env bash
# Idempotent node bootstrap — invoked only from GitHub Actions CI.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/chrisvouga-dev}"
SYSTEMD_UNIT="${SYSTEMD_UNIT:-chrisvouga-dev.service}"
STACK_DESCRIPTION="${STACK_DESCRIPTION:-Docker stack}"

echo "==> Bootstrap origin node (deploy_dir=${DEPLOY_DIR})"

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

UNIT_PATH="/etc/systemd/system/${SYSTEMD_UNIT}"
cat > "${UNIT_PATH}" <<EOF
[Unit]
Description=${STACK_DESCRIPTION}
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${DEPLOY_DIR}
EnvironmentFile=-${DEPLOY_DIR}/.env
ExecStart=${DEPLOY_DIR}/scripts/start-stack.sh
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SYSTEMD_UNIT}"

echo "==> Bootstrap complete"
