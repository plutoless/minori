#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -ne 1 || ! "$1" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: deploy-vultr.sh <full-commit-sha>" >&2
  exit 2
fi

commit_sha="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
env_file="/opt/minori/minori.env"
lark_dir="/opt/minori/lark"
release_dir="/opt/minori/releases"
health_port="${MINORI_HEALTH_PORT:-3000}"
candidate_image="minori:${commit_sha}"
worktree_parent="$(mktemp -d /tmp/minori-release.XXXXXX)"
worktree="$worktree_parent/source"
compose_file="$worktree/deploy/vultr/compose.production.yaml"
previous_image="$(docker inspect --format '{{.Config.Image}}' minori 2>/dev/null || true)"
previous_compose=""
contract_image=""
result="failed"
record_written=0

write_record() {
  mkdir -p "$release_dir"
  local timestamp operator record
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  operator="$(id -un | tr -cd 'A-Za-z0-9._-')"
  record="$release_dir/${timestamp//:/-}-${commit_sha:0:12}.json"
  printf '{"commitSha":"%s","image":"%s","timestamp":"%s","operator":"%s","result":"%s"}\n' \
    "$commit_sha" "$candidate_image" "$timestamp" "$operator" "$result" > "$record"
  record_written=1
}

cleanup() {
  git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rmdir "$worktree_parent" >/dev/null 2>&1 || true
}

on_exit() {
  local exit_code="$?"
  if [[ $record_written -eq 0 ]]; then
    write_record || true
  fi
  cleanup
  return "$exit_code"
}
trap on_exit EXIT

wait_ready() {
  local ready=0
  for _ in $(seq 1 24); do
    if curl --fail --silent --max-time 5 "http://127.0.0.1:${health_port}/health/ready" >/dev/null; then
      ready=1
      break
    fi
    sleep 5
  done
  [[ $ready -eq 1 ]]
}

mkdir -p "$release_dir"
if ! git -C "$repo_root" cat-file -e "${commit_sha}^{commit}"; then
  result="commit_not_found"
  exit 1
fi
if ! git -C "$repo_root" worktree add --detach "$worktree" "$commit_sha"; then
  result="worktree_failed"
  exit 1
fi
if [[ -n "$previous_image" ]]; then
  if [[ ! "$previous_image" =~ ^minori:([0-9a-f]{40})$ ]]; then
    result="previous_release_image_invalid"
    exit 1
  fi
  previous_compose="$release_dir/${BASH_REMATCH[1]}.compose.yaml"
  if [[ ! -r "$previous_compose" ]]; then
    result="previous_release_contract_missing"
    exit 1
  fi
fi
if ! docker build --pull --tag "$candidate_image" "$worktree"; then
  result="build_failed"
  exit 1
fi
contract_image="$(MINORI_IMAGE="$candidate_image" docker compose \
  -f "$compose_file" config --images 2>/dev/null || true)"
if [[ "$contract_image" != "$candidate_image" ]]; then
  result="release_contract_image_mismatch"
  exit 1
fi
if ! docker run --rm \
  --env-file "$env_file" \
  --env LARKSUITE_CLI_CONFIG_DIR=/var/lib/minori/lark/config \
  --env LARKSUITE_CLI_DATA_DIR=/var/lib/minori/lark/data \
  --read-only \
  --tmpfs /tmp:size=64m,mode=1777 \
  --volume "$lark_dir:/var/lib/minori/lark" \
  "$candidate_image" npm run runtime:verify; then
  result="preflight_failed"
  exit 1
fi
if ! docker run --rm \
  --env-file "$env_file" \
  "$candidate_image" npm run db:migrate; then
  result="migration_failed"
  exit 1
fi
if ! install -m 0640 "$compose_file" "$release_dir/${commit_sha}.compose.yaml"; then
  result="release_contract_write_failed"
  exit 1
fi

deploy_failed=0
MINORI_IMAGE="$candidate_image" docker compose --project-name minori \
  -f "$compose_file" up -d --no-build || deploy_failed=1
if [[ $deploy_failed -eq 0 ]] && ! wait_ready; then
  deploy_failed=1
fi

if [[ $deploy_failed -ne 0 ]]; then
  if [[ -n "$previous_image" ]]; then
    if MINORI_IMAGE="$previous_image" docker compose --project-name minori \
      -f "$previous_compose" up -d --no-build \
      && wait_ready; then
      result="rolled_back"
    else
      result="rollback_failed"
    fi
  else
    MINORI_IMAGE="$candidate_image" docker compose --project-name minori \
      -f "$compose_file" down || true
    result="failed_no_previous_release"
  fi
  write_record
  echo "deployment_failed result=${result}" >&2
  exit 1
fi

result="success"
write_record
echo "deployment_succeeded ${commit_sha}"
