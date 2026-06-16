#!/usr/bin/env bash
# Start always-on stack services (traefik + runtime: always_on). Invoked by systemd on boot.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/opt/chrisvouga-dev}"

cd "${DEPLOY_DIR}"

free_host_port() {
  local port="$1"
  local ids
  ids="$(docker ps -q --filter "publish=${port}" 2>/dev/null || true)"
  [[ -z "${ids}" ]] && return 0
  echo "==> Stopping containers on port ${port}"
  docker stop ${ids}
  docker rm -f ${ids} 2>/dev/null || true
}

always_on_services() {
  awk '
    function flush_runtime() {
      if (id != "" && (runtime == "always_on" || id == "traefik")) {
        print id
      }
      id = ""
      runtime = "on_demand"
    }
    /^services:/ { section = "app"; next }
    /^infra_services:/ { section = "infra"; next }
    /^[a-zA-Z_]/ && !/^  / { section = ""; flush_runtime(); next }
    section != "" && /^  - id: / {
      flush_runtime()
      line = $0
      sub(/^  - id: /, "", line)
      gsub(/ *$/, "", line)
      id = line
      next
    }
    section != "" && id != "" && /^    runtime: always_on/ { runtime = "always_on"; next }
    END { flush_runtime() }
  ' services.yaml | sort -u
}

SERVICES=(traefik)
while IFS= read -r svc; do
  [[ -z "${svc}" ]] && continue
  [[ "${svc}" == "traefik" ]] && continue
  SERVICES+=("${svc}")
done < <(always_on_services)

echo "==> Starting always-on services: ${SERVICES[*]}"
docker compose build service-orchestrator 2>/dev/null || true

free_host_port 80
docker compose stop traefik 2>/dev/null || true
docker compose rm -f traefik 2>/dev/null || true
docker compose up -d traefik

REST=()
for svc in "${SERVICES[@]}"; do
  [[ "${svc}" == "traefik" ]] && continue
  REST+=("${svc}")
done
if [[ ${#REST[@]} -gt 0 ]]; then
  docker compose up -d "${REST[@]}"
fi

docker compose ps
