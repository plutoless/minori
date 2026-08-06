#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! "$1" =~ ^minori:[0-9a-f]{40}$ ]]; then
  echo "usage: rollback-vultr.sh minori:<full-commit-sha>" >&2
  exit 2
fi

target_image="$1"
release_dir="/opt/minori/releases"
health_port="${MINORI_HEALTH_PORT:-3000}"
previous_image="$(docker inspect --format '{{.Config.Image}}' minori 2>/dev/null || true)"
target_sha="${target_image#minori:}"
target_compose="$release_dir/${target_sha}.compose.yaml"
previous_compose=""

wait_ready() {
  for _ in $(seq 1 24); do
    if curl --fail --silent --max-time 5 "http://127.0.0.1:${health_port}/health/ready" >/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

docker image inspect "$target_image" >/dev/null
if [[ ! -r "$target_compose" ]]; then
  echo "rollback_release_contract_missing" >&2
  exit 1
fi
if [[ -n "$previous_image" && "$previous_image" != "$target_image" ]]; then
  if [[ ! "$previous_image" =~ ^minori:([0-9a-f]{40})$ ]]; then
    echo "rollback_previous_image_invalid" >&2
    exit 1
  fi
  previous_compose="$release_dir/${BASH_REMATCH[1]}.compose.yaml"
  if [[ ! -r "$previous_compose" ]]; then
    echo "rollback_previous_contract_missing" >&2
    exit 1
  fi
fi

MINORI_IMAGE="$target_image" docker compose --project-name minori \
  -f "$target_compose" up -d --no-build
if wait_ready; then
  echo "rollback_succeeded ${target_image}"
  exit 0
fi

if [[ -n "$previous_image" && "$previous_image" != "$target_image" ]]; then
  if MINORI_IMAGE="$previous_image" docker compose --project-name minori \
    -f "$previous_compose" up -d --no-build \
    && wait_ready; then
    echo "rollback_target_unhealthy_restored_previous" >&2
    exit 1
  fi
fi

echo "rollback_target_and_restore_unhealthy" >&2
exit 1
