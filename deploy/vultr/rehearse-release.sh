#!/bin/bash
set -euo pipefail
umask 077

sha_pattern='^[0-9a-f]{40}$'
digest_pattern='^ghcr\.io/plutoless/minori@sha256:[0-9a-f]{64}$'
legacy_pattern='^minori:[0-9a-f]{40}$'

finish() {
  printf 'minori_rehearsal result=%s\n' "$1"
  exit "$2"
}

if [[ $# -ne 2 || ! "$1" =~ $sha_pattern || ! "$2" =~ $digest_pattern ]]; then
  finish rejected 2
fi
expected_sha="$1"
expected_image="$2"
installed_rehearsal='/opt/minori/bin/rehearse-release'
test_mode=0
if [[ "${BASH_SOURCE[0]}" == "$installed_rehearsal" ]]; then
  if [[ $EUID -ne 0 ]]; then
    finish rejected 2
  fi
  PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  export PATH
  minori_root='/opt/minori'
elif [[ -n "${MINORI_TEST_ROOT:-}" && -d "$MINORI_TEST_ROOT" && -O "$MINORI_TEST_ROOT" ]]; then
  test_mode=1
  minori_root="$MINORI_TEST_ROOT"
else
  finish rejected 2
fi
release_dir="${minori_root}/releases"
contracts_dir="${release_dir}/contracts"
state_file="${release_dir}/state.tsv"
env_file="${minori_root}/minori.env"
health_port="${MINORI_HEALTH_PORT:-3000}"
lock_file='/run/lock/minori-ci-deploy.lock'
ready_attempts=24
ready_delay=5
if [[ $test_mode -eq 1 ]]; then
  lock_file="${MINORI_DEPLOY_LOCK_FILE:-${minori_root}/ci-deploy.lock}"
  ready_attempts="${MINORI_READY_ATTEMPTS:-1}"
  ready_delay="${MINORI_READY_DELAY_SECONDS:-0}"
fi

open_lock_file() {
  exec 9>"$lock_file"
}
if ! open_lock_file 2>/dev/null; then
  finish failed_before_switch 1
fi
if ! flock -n 9 2>/dev/null; then
  finish locked 75
fi

declare -a state_shas=()
declare -a state_images=()
declare -a state_contracts=()
state_count=0
temporary_dir=''
temporary_container=''

cleanup() {
  if [[ -n "$temporary_container" ]]; then
    docker rm -f "$temporary_container" >/dev/null 2>&1 || true
  fi
  if [[ -n "$temporary_dir" && -d "$temporary_dir" ]]; then
    rm -rf -- "$temporary_dir"
  fi
}
trap cleanup EXIT

file_mode() {
  local path="$1"
  local mode
  if mode="$(stat -c '%a' -- "$path" 2>/dev/null)"; then
    printf '%s\n' "$mode"
    return 0
  fi
  stat -f '%Lp' -- "$path" 2>/dev/null
}

trusted_directory_is_valid() {
  local path="$1"
  local mode
  [[ -d "$path" && ! -L "$path" && -O "$path" ]] || return 1
  mode="$(file_mode "$path")" || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$mode & 8#022) == 0 ))
}

root_only_file_is_valid() {
  local path="$1"
  local mode
  [[ -f "$path" && ! -L "$path" && -O "$path" ]] || return 1
  mode="$(file_mode "$path")" || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$mode & 8#077) == 0 ))
}

contract_file_is_valid() {
  local path="$1"
  local mode
  [[ -f "$path" && ! -L "$path" && -O "$path" && -r "$path" ]] || return 1
  mode="$(file_mode "$path")" || return 1
  [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  (( (8#$mode & 8#022) == 0 ))
}

contract_path_is_valid() {
  local sha="$1"
  local image="$2"
  local contract="$3"
  local digest_hex
  if [[ "$image" =~ $digest_pattern ]]; then
    digest_hex="${image##*@sha256:}"
    [[ "$contract" == "${contracts_dir}/${digest_hex}.compose.yaml" ]] \
      && contract_file_is_valid "$contract"
    return
  fi
  if [[ "$image" =~ $legacy_pattern ]]; then
    [[ "${image#minori:}" == "$sha" && "$contract" == "${release_dir}/${sha}.compose.yaml" ]] \
      && contract_file_is_valid "$contract"
    return
  fi
  return 1
}

release_image_metadata_is_valid() {
  local sha="$1"
  local image="$2"
  local revision architecture user repository_digest
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    return 1
  fi
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image" 2>/dev/null)" \
    || return 1
  architecture="$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null)" \
    || return 1
  user="$(docker image inspect --format '{{.Config.User}}' "$image" 2>/dev/null)" \
    || return 1
  [[ "$revision" == "$sha" && "$architecture" == amd64 && "$user" == '10001:10001' ]] \
    || return 1
  if [[ "$image" =~ $digest_pattern ]]; then
    repository_digest="$(docker image inspect --format '{{join .RepoDigests "\n"}}' "$image" 2>/dev/null)" \
      || return 1
    [[ "$repository_digest" == "$image" ]]
    return
  fi
  [[ "$image" =~ $legacy_pattern ]]
}

embedded_protocol_is_valid() {
  local image="$1"
  local suffix="$2"
  local protocol_copy="${temporary_dir}/${suffix}.deployment-protocol"
  if ! temporary_container="$(docker create "$image" 2>/dev/null)" || [[ -z "$temporary_container" ]]; then
    return 1
  fi
  if ! docker cp "${temporary_container}:/opt/minori/release/deployment-protocol" "$protocol_copy" >/dev/null 2>&1 \
    || ! docker rm -f "$temporary_container" >/dev/null 2>&1; then
    return 1
  fi
  temporary_container=''
  [[ -f "$protocol_copy" && ! -L "$protocol_copy" && "$(<"$protocol_copy")" == v1 ]]
}

saved_release_is_valid() {
  local sha="$1"
  local image="$2"
  local contract="$3"
  local suffix="$4"
  local rendered
  contract_path_is_valid "$sha" "$image" "$contract" || return 1
  release_image_metadata_is_valid "$sha" "$image" || return 1
  if [[ "$image" =~ $digest_pattern ]]; then
    embedded_protocol_is_valid "$image" "$suffix" || return 1
  fi
  rendered="$(compose_image "$image" "$contract")" || return 1
  [[ "$rendered" == "$image" ]]
}

load_state() {
  local row row_protocol row_sha row_image row_contract extra serialized index
  if [[ ! -r "$state_file" || ! -s "$state_file" ]] || ! root_only_file_is_valid "$state_file"; then
    return 1
  fi
  while IFS= read -r row || [[ -n "$row" ]]; do
    IFS=$'\t' read -r row_protocol row_sha row_image row_contract extra <<< "$row"
    serialized="${row_protocol}"$'\t'"${row_sha}"$'\t'"${row_image}"$'\t'"${row_contract}"
    if [[ "$row" != "$serialized" || -n "$extra" || "$row_protocol" != v1 || ! "$row_sha" =~ $sha_pattern ]]; then
      return 1
    fi
    if ! saved_release_is_valid "$row_sha" "$row_image" "$row_contract" "saved-${state_count}" \
      || [[ $state_count -ge 3 ]]; then
      return 1
    fi
    for ((index = 0; index < state_count; index += 1)); do
      if [[ "${state_images[$index]}" == "$row_image" ]]; then
        return 1
      fi
    done
    state_shas[$state_count]="$row_sha"
    state_images[$state_count]="$row_image"
    state_contracts[$state_count]="$row_contract"
    state_count=$((state_count + 1))
  done < "$state_file"
  [[ $state_count -ge 2 ]]
}

wait_ready() {
  local attempt
  for ((attempt = 0; attempt < ready_attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 \
      "http://127.0.0.1:${health_port}/health/ready" >/dev/null 2>&1; then
      return 0
    fi
    if [[ $((attempt + 1)) -lt $ready_attempts ]]; then
      sleep "$ready_delay"
    fi
  done
  return 1
}

compose_image() {
  local image="$1"
  local contract="$2"
  MINORI_IMAGE="$image" MINORI_ENV_FILE="$env_file" \
    docker compose --project-name minori -f "$contract" config --images 2>/dev/null
}

replace_service() {
  local image="$1"
  local contract="$2"
  MINORI_IMAGE="$image" MINORI_ENV_FILE="$env_file" \
    docker compose --project-name minori -f "$contract" up -d --no-build >/dev/null 2>&1
}

if ! trusted_directory_is_valid "$minori_root" || ! trusted_directory_is_valid "$release_dir" \
  || ! trusted_directory_is_valid "$contracts_dir" || ! root_only_file_is_valid "$env_file"; then
  finish rejected 2
fi
if ! temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/minori-rehearsal.XXXXXX")" || ! load_state; then
  finish rejected 2
fi
if [[ "${state_shas[0]}" != "$expected_sha" || "${state_images[0]}" != "$expected_image" ]]; then
  finish rejected 2
fi
if [[ ! "${state_images[0]}" =~ $digest_pattern ]]; then
  finish rejected 2
fi
if ! running_image="$(docker inspect --format '{{.Config.Image}}' minori 2>/dev/null)" \
  || [[ "$running_image" != "$expected_image" ]]; then
  finish rejected 2
fi
if ! current_rendered="$(compose_image "${state_images[0]}" "${state_contracts[0]}")" \
  || [[ "$current_rendered" != "${state_images[0]}" ]]; then
  finish rejected 2
fi
if ! predecessor_rendered="$(compose_image "${state_images[1]}" "${state_contracts[1]}")" \
  || [[ "$predecessor_rendered" != "${state_images[1]}" ]]; then
  finish rejected 2
fi

if ! replace_service "${state_images[1]}" "${state_contracts[1]}" || ! wait_ready; then
  if replace_service "${state_images[0]}" "${state_contracts[0]}" && wait_ready; then
    finish predecessor_unhealthy_restored 1
  fi
  finish predecessor_unhealthy_restore_failed 1
fi

if ! replace_service "${state_images[0]}" "${state_contracts[0]}" || ! wait_ready; then
  finish restore_failed 1
fi

finish success 0
