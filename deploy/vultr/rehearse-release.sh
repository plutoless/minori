#!/bin/bash
set -euo pipefail
umask 077
LC_ALL=C
LANG=C
export LC_ALL LANG

installed_rehearsal='/opt/minori/bin/rehearse-release'
sanitized_path='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
if [[ "${BASH_SOURCE[0]}" == "$installed_rehearsal" ]]; then
  installed_environment_is_clean=1
  while IFS= read -r variable_name; do
    case "$variable_name" in
      LANG|LC_ALL|MINORI_REHEARSAL_SANITIZED|PATH|PWD|SHLVL|_) ;;
      *) installed_environment_is_clean=0 ;;
    esac
  done < <(compgen -e)
  if [[ "${MINORI_REHEARSAL_SANITIZED:-}" != 1 || "$installed_environment_is_clean" -ne 1 \
    || "$PATH" != "$sanitized_path" || "$LANG" != C || "$LC_ALL" != C ]]; then
    exec /usr/bin/env -i "PATH=${sanitized_path}" MINORI_REHEARSAL_SANITIZED=1 "$installed_rehearsal" "$@"
  fi
elif [[ "${MINORI_REHEARSAL_SANITIZED:-}" != 1 ]]; then
  if [[ -n "${MINORI_TEST_ROOT:-}" && -d "$MINORI_TEST_ROOT" && ! -L "$MINORI_TEST_ROOT" && -O "$MINORI_TEST_ROOT" ]]; then
    test_environment=(/usr/bin/env -i "PATH=${PATH}" MINORI_REHEARSAL_SANITIZED=1 MINORI_TEST_ROOT="$MINORI_TEST_ROOT")
    while IFS= read -r variable_name; do
      case "$variable_name" in
        FAKE_*|MINORI_DEPLOY_LOCK_FILE|MINORI_READY_ATTEMPTS|MINORI_READY_DELAY_SECONDS|MINORI_TEST_*)
          [[ "$variable_name" == MINORI_TEST_ROOT ]] \
            || test_environment+=("${variable_name}=${!variable_name}")
          ;;
      esac
    done < <(compgen -e)
    exec "${test_environment[@]}" "${BASH_SOURCE[0]}" "$@"
  fi
fi

sha_pattern='^[0123456789abcdef]{40}$'
digest_pattern='^ghcr\.io/plutoless/minori@sha256:[0123456789abcdef]{64}$'
legacy_pattern='^minori:[0123456789abcdef]{40}$'

finish() {
  terminal_emitted=1
  printf 'minori_rehearsal result=%s\n' "$1"
  exit "$2"
}

if [[ $# -ne 2 || ! "$1" =~ $sha_pattern || ! "$2" =~ $digest_pattern ]]; then
  terminal_emitted=1
  finish rejected 2
fi
expected_sha="$1"
expected_image="$2"
test_mode=0
if [[ "${BASH_SOURCE[0]}" == "$installed_rehearsal" ]]; then
  if [[ $EUID -ne 0 ]]; then
    terminal_emitted=1
    finish rejected 2
  fi
  PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  export PATH
  minori_root='/opt/minori'
elif [[ -n "${MINORI_TEST_ROOT:-}" && -d "$MINORI_TEST_ROOT" && ! -L "$MINORI_TEST_ROOT" && -O "$MINORI_TEST_ROOT" ]]; then
  test_mode=1
  minori_root="$MINORI_TEST_ROOT"
else
  terminal_emitted=1
  finish rejected 2
fi

release_dir="${minori_root}/releases"
contracts_dir="${release_dir}/contracts"
records_dir="${release_dir}/records"
rehearsal_records_dir="${release_dir}/rehearsal-records"
state_file="${release_dir}/state.tsv"
pending_file="${release_dir}/pending.tsv"
consumed_file="${release_dir}/rehearsal-v0.1.1.accepted"
env_file="${minori_root}/minori.env"
lark_dir="${minori_root}/lark"
health_port=3000
lock_file='/run/lock/minori-ci-deploy.lock'
ready_attempts=24
ready_delay=5
if [[ $test_mode -eq 1 ]]; then
  lock_file="${MINORI_DEPLOY_LOCK_FILE:-${minori_root}/ci-deploy.lock}"
  ready_attempts="${MINORI_READY_ATTEMPTS:-1}"
  ready_delay="${MINORI_READY_DELAY_SECONDS:-0}"
  transition_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  transition_image='ghcr.io/plutoless/minori@sha256:1111111111111111111111111111111111111111111111111111111111111111'
  predecessor_sha='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  predecessor_image='ghcr.io/plutoless/minori@sha256:2222222222222222222222222222222222222222222222222222222222222222'
else
  transition_sha='88cfe2bd0cde870e1c77ea71b035f7c1c2b1b599'
  transition_image='ghcr.io/plutoless/minori@sha256:b9fbe52a854c18578bbfeb989ed39b2955aafe46dcb230e7567f8228b9754bbb'
  predecessor_sha='cea9107ab9bc2f85635a2f999dc834fafb8e5a82'
  predecessor_image='minori:cea9107ab9bc2f85635a2f999dc834fafb8e5a82'
fi
consumed_content=$'v1\t'"${transition_sha}"$'\t'"${transition_image}"$'\t'"${predecessor_sha}"$'\t'"${predecessor_image}"

open_lock_file() { exec 9>"$lock_file"; }
open_lock_file 2>/dev/null || finish failed_before_switch 1
flock -n 9 2>/dev/null || finish locked 75

declare -a state_protocols=() state_shas=() state_images=() state_contracts=()
declare -a next_protocols=() next_shas=() next_images=() next_contracts=()
declare -a pending_state_protocols=() pending_state_shas=() pending_state_images=() pending_state_contracts=()
state_count=0
next_count=0
state_file_existed=0
pending_state_count=0
pending_state_existed=0
pending_operation=''
pending_phase=''
pending_original_protocol=''
pending_original_sha=''
pending_original_image=''
pending_original_contract=''
pending_alternate_protocol=''
pending_alternate_sha=''
pending_alternate_image=''
pending_alternate_contract=''
pending_record_timestamp=''
pending_record_nonce=''
temporary_dir=''
temporary_container=''
state_temporary=''
pending_temporary=''
record_temporary=''
transaction_active=0
terminal_emitted=0
recovery_active=0
original_sha=''
original_image=''
original_contract=''

cleanup() {
  if [[ -n "$temporary_container" ]]; then docker rm -f "$temporary_container" >/dev/null 2>&1 || true; fi
  if [[ -n "$state_temporary" ]]; then rm -f -- "$state_temporary"; fi
  if [[ -n "$pending_temporary" ]]; then rm -f -- "$pending_temporary"; fi
  if [[ -n "$record_temporary" ]]; then rm -f -- "$record_temporary"; fi
  if [[ -n "$temporary_dir" && -d "$temporary_dir" ]]; then rm -rf -- "$temporary_dir"; fi
}

consumed_file_is_valid() {
  root_only_file_is_valid "$consumed_file" && [[ "$(<"$consumed_file")" == "$consumed_content" ]]
}

ensure_consumed_file() {
  local temporary_consumed
  if [[ -e "$consumed_file" || -L "$consumed_file" ]]; then
    consumed_file_is_valid
    return
  fi
  temporary_consumed="$(mktemp "${release_dir}/.rehearsal-v0.1.1.accepted.XXXXXX")" || return 1
  if ! printf '%s\n' "$consumed_content" > "$temporary_consumed" \
    || ! chmod 0600 "$temporary_consumed" || ! mv -f -- "$temporary_consumed" "$consumed_file"; then
    rm -f -- "$temporary_consumed"
    return 1
  fi
  consumed_file_is_valid
}

file_mode() {
  local path="$1" mode
  if mode="$(stat -c '%a' -- "$path" 2>/dev/null)"; then printf '%s\n' "$mode"; return 0; fi
  stat -f '%Lp' -- "$path" 2>/dev/null
}

path_ids() {
  local path="$1" ids
  if ids="$(stat -c '%u %g' -- "$path" 2>/dev/null)"; then printf '%s\n' "$ids"; return 0; fi
  stat -f '%u %g' -- "$path" 2>/dev/null
}

expected_root_ids() {
  if [[ $test_mode -eq 1 ]]; then printf '%s %s\n' "$(id -u)" "$(id -g)"; else printf '0 0\n'; fi
}

trusted_directory_is_valid() {
  local path="$1" mode ids
  [[ -d "$path" && ! -L "$path" ]] || return 1
  mode="$(file_mode "$path")" || return 1
  ids="$(path_ids "$path")" || return 1
  [[ "$ids" == "$(expected_root_ids)" && "$mode" =~ ^[01234567]{3,4}$ ]] || return 1
  (( (8#$mode & 8#022) == 0 ))
}

prepare_trusted_directory() {
  local path="$1"
  if [[ -L "$path" ]] || { [[ -e "$path" ]] && ! trusted_directory_is_valid "$path"; }; then
    return 1
  fi
  if [[ ! -e "$path" ]]; then
    mkdir -- "$path" || return 1
  fi
  trusted_directory_is_valid "$path"
}

root_only_file_is_valid() {
  local path="$1" mode ids
  [[ -f "$path" && ! -L "$path" ]] || return 1
  mode="$(file_mode "$path")" || return 1
  ids="$(path_ids "$path")" || return 1
  [[ "$ids" == "$(expected_root_ids)" && "$mode" == 600 ]]
}

contract_file_is_valid() {
  local path="$1" mode ids
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || return 1
  mode="$(file_mode "$path")" || return 1
  ids="$(path_ids "$path")" || return 1
  [[ "$ids" == "$(expected_root_ids)" && "$mode" =~ ^[01234567]{3,4}$ ]] || return 1
  (( (8#$mode & 8#022) == 0 ))
}

lark_directory_is_valid() {
  local mode ids expected_ids
  [[ -d "$lark_dir" && ! -L "$lark_dir" ]] || return 1
  mode="$(file_mode "$lark_dir")" || return 1
  ids="$(path_ids "$lark_dir")" || return 1
  if [[ $test_mode -eq 1 ]]; then expected_ids="$(id -u) $(id -g)"; else expected_ids='10001 10001'; fi
  [[ "$ids" == "$expected_ids" && "$mode" =~ ^[01234567]{3,4}$ ]] || return 1
  (( (8#$mode & 8#027) == 0 ))
}

compose_image() {
  local image="$1" contract="$2"
  MINORI_IMAGE="$image" MINORI_ENV_FILE="$env_file" docker compose --project-name minori -f "$contract" config --images 2>/dev/null
}

replace_service() {
  local image="$1" contract="$2"
  MINORI_IMAGE="$image" MINORI_ENV_FILE="$env_file" docker compose --project-name minori -f "$contract" up -d --no-build >/dev/null 2>&1
}

wait_ready() {
  local attempt
  for ((attempt = 0; attempt < ready_attempts; attempt += 1)); do
    if curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${health_port}/health/ready" >/dev/null 2>&1; then return 0; fi
    if [[ $((attempt + 1)) -lt $ready_attempts ]]; then sleep "$ready_delay"; fi
  done
  return 1
}

running_image_equals() {
  local expected="$1" running
  running="$(docker inspect --format '{{.Config.Image}}' minori 2>/dev/null)" || return 1
  [[ "$running" == "$expected" ]]
}

service_is_healthy() { running_image_equals "$1" && wait_ready; }

contract_path_is_valid() {
  local sha="$1" image="$2" contract="$3" digest_hex
  if [[ "$image" =~ $digest_pattern ]]; then
    digest_hex="${image##*@sha256:}"
    [[ "$contract" == "${contracts_dir}/${digest_hex}.compose.yaml" ]] && contract_file_is_valid "$contract"
    return
  fi
  if [[ "$image" =~ $legacy_pattern ]]; then
    [[ "${image#minori:}" == "$sha" && "$contract" == "${release_dir}/${sha}.compose.yaml" ]] && contract_file_is_valid "$contract"
    return
  fi
  return 1
}

release_image_metadata_is_valid() {
  local sha="$1" image="$2" revision architecture user repository_digest
  docker image inspect "$image" >/dev/null 2>&1 || return 1
  revision="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image" 2>/dev/null)" || return 1
  architecture="$(docker image inspect --format '{{.Architecture}}' "$image" 2>/dev/null)" || return 1
  user="$(docker image inspect --format '{{.Config.User}}' "$image" 2>/dev/null)" || return 1
  [[ "$revision" == "$sha" && "$architecture" == amd64 && "$user" == '10001:10001' ]] || return 1
  if [[ "$image" =~ $digest_pattern ]]; then
    repository_digest="$(docker image inspect --format '{{join .RepoDigests "\n"}}' "$image" 2>/dev/null)" || return 1
    [[ "$repository_digest" == "$image" ]]
    return
  fi
  [[ "$image" =~ $legacy_pattern ]]
}

embedded_protocol_is_valid() {
  local image="$1" suffix="$2" protocol_copy="${temporary_dir}/${suffix}.deployment-protocol"
  temporary_container="$(docker create "$image" 2>/dev/null)" || return 1
  [[ -n "$temporary_container" ]] || return 1
  if ! docker cp "${temporary_container}:/opt/minori/release/deployment-protocol" "$protocol_copy" >/dev/null 2>&1 \
    || ! docker rm -f "$temporary_container" >/dev/null 2>&1; then return 1; fi
  temporary_container=''
  [[ -f "$protocol_copy" && ! -L "$protocol_copy" && "$(<"$protocol_copy")" == v1 ]]
}

saved_release_is_valid() {
  local sha="$1" image="$2" contract="$3" suffix="$4" rendered
  contract_path_is_valid "$sha" "$image" "$contract" || return 1
  release_image_metadata_is_valid "$sha" "$image" || return 1
  if [[ "$image" =~ $digest_pattern ]]; then embedded_protocol_is_valid "$image" "$suffix" || return 1; fi
  rendered="$(compose_image "$image" "$contract")" || return 1
  [[ "$rendered" == "$image" ]]
}

reset_state() {
  state_protocols=(); state_shas=(); state_images=(); state_contracts=(); state_count=0; state_file_existed=0
}

load_state() {
  local row row_protocol row_sha row_image row_contract extra serialized index
  if [[ ! -e "$state_file" ]]; then return 0; fi
  state_file_existed=1
  [[ -r "$state_file" && -s "$state_file" ]] && root_only_file_is_valid "$state_file" || return 1
  while IFS= read -r row || [[ -n "$row" ]]; do
    IFS=$'\t' read -r row_protocol row_sha row_image row_contract extra <<< "$row"
    serialized="${row_protocol}"$'\t'"${row_sha}"$'\t'"${row_image}"$'\t'"${row_contract}"
    [[ "$row" == "$serialized" && -z "$extra" && "$row_protocol" == v1 && "$row_sha" =~ $sha_pattern \
      && $state_count -lt 3 ]] || return 1
    saved_release_is_valid "$row_sha" "$row_image" "$row_contract" "saved-${state_count}" || return 1
    for ((index = 0; index < state_count; index += 1)); do [[ "${state_images[$index]}" != "$row_image" ]] || return 1; done
    state_protocols[$state_count]="$row_protocol"
    state_shas[$state_count]="$row_sha"
    state_images[$state_count]="$row_image"
    state_contracts[$state_count]="$row_contract"
    state_count=$((state_count + 1))
  done < "$state_file"
  [[ $state_count -gt 0 ]]
}

write_next_state() {
  local index
  state_temporary="${state_file}.tmp.$$"
  : > "$state_temporary" || return 1
  for ((index = 0; index < next_count; index += 1)); do
    printf '%s\t%s\t%s\t%s\n' "${next_protocols[$index]}" "${next_shas[$index]}" \
      "${next_images[$index]}" "${next_contracts[$index]}" >> "$state_temporary" || return 1
  done
  chmod 0600 "$state_temporary" && mv -f "$state_temporary" "$state_file" || return 1
  state_temporary=''
}

restore_original_state() {
  local index
  next_protocols=(); next_shas=(); next_images=(); next_contracts=(); next_count=$state_count
  for ((index = 0; index < state_count; index += 1)); do
    next_protocols[$index]="${state_protocols[$index]}"; next_shas[$index]="${state_shas[$index]}"
    next_images[$index]="${state_images[$index]}"; next_contracts[$index]="${state_contracts[$index]}"
  done
  write_next_state
}

record_timestamp_is_valid() {
  [[ "$1" =~ ^[0123456789]{4}-[0123456789]{2}-[0123456789]{2}T[0123456789]{2}:[0123456789]{2}:[0123456789]{2}Z$ ]]
}

initialize_pending_record_identity() {
  local random_suffix="${temporary_dir##*.}"
  pending_record_timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)" || return 1
  record_timestamp_is_valid "$pending_record_timestamp" || return 1
  [[ "$random_suffix" =~ ^[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789]{6}$ ]] || return 1
  pending_record_nonce="$$-${random_suffix}"
  [[ "$pending_record_nonce" =~ ^[123456789][0123456789]*-[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789]{6}$ ]]
}

ensure_record_file() {
  local directory="$1" record_name="$2" expected_content="$3" result="$4" final_record
  final_record="${directory}/${record_name}"
  record_temporary="${directory}/.${record_name}.tmp"
  if [[ -L "$record_temporary" ]] || { [[ -e "$record_temporary" ]] && ! root_only_file_is_valid "$record_temporary"; }; then return 1; fi
  if ! printf '%s\n' "$expected_content" > "$record_temporary" || ! chmod 0600 "$record_temporary"; then
    rm -f -- "$record_temporary"; record_temporary=''; return 1
  fi
  if [[ -e "$final_record" ]]; then
    if ! root_only_file_is_valid "$final_record" || ! cmp -s "$record_temporary" "$final_record"; then
      rm -f -- "$record_temporary"; record_temporary=''; return 1
    fi
    rm -f -- "$record_temporary" || return 1
    record_temporary=''
    return 0
  fi
  if [[ $test_mode -eq 1 && "${MINORI_TEST_FAIL_RECORD_RESULT:-}" == "$result" ]]; then
    rm -f -- "$record_temporary"; record_temporary=''; return 1
  fi
  if ! mv -f "$record_temporary" "$final_record"; then
    rm -f -- "$record_temporary"; record_temporary=''; return 1
  fi
  record_temporary=''
}

ensure_pending_deploy_record() {
  local result="$1" rollback_target="$2" timestamp_name record_name expected_content
  case "$result:$rollback_target" in
    success:none|rolled_back:legacy_local|rolled_back:saved_digest|rollback_failed:legacy_local|rollback_failed:saved_digest) ;;
    *) return 1 ;;
  esac
  timestamp_name="${pending_record_timestamp//:/-}"
  record_name="${timestamp_name}-${pending_alternate_sha:0:12}-${pending_record_nonce}-${result}.json"
  expected_content="{\"protocol\":\"${pending_alternate_protocol}\",\"commitSha\":\"${pending_alternate_sha}\",\"image\":\"${pending_alternate_image}\",\"timestamp\":\"${pending_record_timestamp}\",\"operatorCategory\":\"github_actions\",\"result\":\"${result}\",\"rollbackTargetCategory\":\"${rollback_target}\"}"
  ensure_record_file "$records_dir" "$record_name" "$expected_content" "$result"
}

ensure_pending_rehearsal_failure() {
  local timestamp_name record_name expected_content result='restore_failed_recovered_predecessor'
  timestamp_name="${pending_record_timestamp//:/-}"
  record_name="${timestamp_name}-${pending_alternate_sha:0:12}-${pending_record_nonce}-${result}.json"
  expected_content="{\"protocol\":\"v1\",\"timestamp\":\"${pending_record_timestamp}\",\"result\":\"${result}\",\"recoveredSha\":\"${pending_alternate_sha}\",\"recoveredImage\":\"${pending_alternate_image}\"}"
  ensure_record_file "$rehearsal_records_dir" "$record_name" "$expected_content" "$result"
}

pending_phase_is_valid() {
  case "$1:$2" in
    deploy:prepared|deploy:replaced|deploy:healthy|deploy:state_written|rehearsal:prepared|rehearsal:predecessor_proven|rehearsal:restoring_current|rehearsal:current_restored|rehearsal:fallback) return 0 ;;
  esac
  return 1
}

write_pending() {
  local operation="$1" phase="$2" original_protocol="$3" original_sha_arg="$4" original_image_arg="$5" original_contract_arg="$6"
  local alternate_protocol="$7" alternate_sha="$8" alternate_image="$9" alternate_contract="${10}" index
  if [[ $test_mode -eq 1 && "${MINORI_TEST_FAIL_PENDING_PHASE:-}" == "$phase" ]]; then return 1; fi
  pending_temporary="${pending_file}.tmp.$$"
  : > "$pending_temporary" || return 1
  printf 'v1\t%s\t%s\t%s\t%s\t%s\t%s\n' "$operation" "$phase" "$state_file_existed" "$state_count" \
    "$pending_record_timestamp" "$pending_record_nonce" >> "$pending_temporary" || return 1
  printf 'original\t%s\t%s\t%s\t%s\n' "$original_protocol" "$original_sha_arg" "$original_image_arg" "$original_contract_arg" >> "$pending_temporary" || return 1
  printf 'alternate\t%s\t%s\t%s\t%s\n' "$alternate_protocol" "$alternate_sha" "$alternate_image" "$alternate_contract" >> "$pending_temporary" || return 1
  for ((index = 0; index < state_count; index += 1)); do
    printf 'state\t%s\t%s\t%s\t%s\n' "${state_protocols[$index]}" "${state_shas[$index]}" \
      "${state_images[$index]}" "${state_contracts[$index]}" >> "$pending_temporary" || return 1
  done
  chmod 0600 "$pending_temporary" && mv -f "$pending_temporary" "$pending_file" || return 1
  pending_temporary=''
}

update_pending_phase() {
  write_pending "$pending_operation" "$1" "$pending_original_protocol" "$pending_original_sha" \
    "$pending_original_image" "$pending_original_contract" "$pending_alternate_protocol" \
    "$pending_alternate_sha" "$pending_alternate_image" "$pending_alternate_contract" || return 1
  pending_phase="$1"
}

load_pending() {
  local -a lines=()
  local line header_protocol header_serialized extra tag row_protocol row_sha row_image row_contract serialized index previous expected_lines
  [[ -e "$pending_file" ]] || return 2
  [[ -r "$pending_file" && -s "$pending_file" ]] && root_only_file_is_valid "$pending_file" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do lines[${#lines[@]}]="$line"; done < "$pending_file"
  [[ ${#lines[@]} -ge 3 ]] || return 1
  IFS=$'\t' read -r header_protocol pending_operation pending_phase pending_state_existed pending_state_count \
    pending_record_timestamp pending_record_nonce extra <<< "${lines[0]}"
  header_serialized="v1"$'\t'"${pending_operation}"$'\t'"${pending_phase}"$'\t'"${pending_state_existed}"$'\t'"${pending_state_count}"$'\t'"${pending_record_timestamp}"$'\t'"${pending_record_nonce}"
  [[ "${lines[0]}" == "$header_serialized" && -z "$extra" && "$header_protocol" == v1 \
    && "$pending_state_existed" =~ ^[01]$ && "$pending_state_count" =~ ^[0123]$ \
    && "$pending_record_nonce" =~ ^[123456789][0123456789]*-[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789]{6}$ ]] || return 1
  record_timestamp_is_valid "$pending_record_timestamp" || return 1
  pending_phase_is_valid "$pending_operation" "$pending_phase" || return 1
  [[ "$pending_state_existed" == 1 || "$pending_state_count" == 0 ]] || return 1
  [[ "$pending_state_existed" == 0 || "$pending_state_count" -gt 0 ]] || return 1
  expected_lines=$((3 + pending_state_count)); [[ ${#lines[@]} -eq $expected_lines ]] || return 1
  IFS=$'\t' read -r tag pending_original_protocol pending_original_sha pending_original_image pending_original_contract extra <<< "${lines[1]}"
  serialized="original"$'\t'"${pending_original_protocol}"$'\t'"${pending_original_sha}"$'\t'"${pending_original_image}"$'\t'"${pending_original_contract}"
  [[ "${lines[1]}" == "$serialized" && -z "$extra" && "$pending_original_protocol" == v1 && "$pending_original_sha" =~ $sha_pattern ]] || return 1
  saved_release_is_valid "$pending_original_sha" "$pending_original_image" "$pending_original_contract" pending-original || return 1
  IFS=$'\t' read -r tag pending_alternate_protocol pending_alternate_sha pending_alternate_image pending_alternate_contract extra <<< "${lines[2]}"
  serialized="alternate"$'\t'"${pending_alternate_protocol}"$'\t'"${pending_alternate_sha}"$'\t'"${pending_alternate_image}"$'\t'"${pending_alternate_contract}"
  [[ "${lines[2]}" == "$serialized" && -z "$extra" && "$pending_alternate_protocol" == v1 && "$pending_alternate_sha" =~ $sha_pattern ]] || return 1
  saved_release_is_valid "$pending_alternate_sha" "$pending_alternate_image" "$pending_alternate_contract" pending-alternate || return 1
  pending_state_protocols=(); pending_state_shas=(); pending_state_images=(); pending_state_contracts=()
  for ((index = 0; index < pending_state_count; index += 1)); do
    IFS=$'\t' read -r tag row_protocol row_sha row_image row_contract extra <<< "${lines[$((index + 3))]}"
    serialized="state"$'\t'"${row_protocol}"$'\t'"${row_sha}"$'\t'"${row_image}"$'\t'"${row_contract}"
    [[ "${lines[$((index + 3))]}" == "$serialized" && -z "$extra" && "$row_protocol" == v1 && "$row_sha" =~ $sha_pattern ]] || return 1
    saved_release_is_valid "$row_sha" "$row_image" "$row_contract" "pending-state-${index}" || return 1
    for ((previous = 0; previous < index; previous += 1)); do
      [[ "${pending_state_images[$previous]}" != "$row_image" ]] || return 1
    done
    pending_state_protocols[$index]="$row_protocol"; pending_state_shas[$index]="$row_sha"
    pending_state_images[$index]="$row_image"; pending_state_contracts[$index]="$row_contract"
  done
  if [[ $pending_state_existed -eq 1 ]]; then
    [[ "${pending_state_images[0]}" == "$pending_original_image" && "${pending_state_shas[0]}" == "$pending_original_sha" \
      && "${pending_state_contracts[0]}" == "$pending_original_contract" ]] || return 1
  fi
  if [[ "$pending_operation" == deploy ]]; then
    [[ "$pending_alternate_image" =~ $digest_pattern ]] || return 1
    if [[ $pending_state_existed -eq 0 ]]; then [[ "$pending_original_image" =~ $legacy_pattern ]] || return 1; fi
  else
    [[ $pending_state_existed -eq 1 && $pending_state_count -ge 2 \
      && "$pending_original_image" =~ $digest_pattern \
      && "${pending_state_images[1]}" == "$pending_alternate_image" \
      && "${pending_state_shas[1]}" == "$pending_alternate_sha" \
      && "${pending_state_contracts[1]}" == "$pending_alternate_contract" ]] || return 1
    [[ "$pending_original_sha" == "$transition_sha" && "$pending_original_image" == "$transition_image" \
      && "$pending_alternate_sha" == "$predecessor_sha" && "$pending_alternate_image" == "$predecessor_image" ]] || return 1
  fi
}

restore_pending_state() {
  local index
  if [[ $pending_state_existed -eq 0 ]]; then rm -f -- "$state_file"; return; fi
  next_protocols=(); next_shas=(); next_images=(); next_contracts=(); next_count=$pending_state_count
  for ((index = 0; index < pending_state_count; index += 1)); do
    next_protocols[$index]="${pending_state_protocols[$index]}"; next_shas[$index]="${pending_state_shas[$index]}"
    next_images[$index]="${pending_state_images[$index]}"; next_contracts[$index]="${pending_state_contracts[$index]}"
  done
  write_next_state
}

promote_pending_alternate() {
  local index
  next_protocols=(); next_shas=(); next_images=(); next_contracts=()
  next_protocols[0]="$pending_alternate_protocol"; next_shas[0]="$pending_alternate_sha"
  next_images[0]="$pending_alternate_image"; next_contracts[0]="$pending_alternate_contract"; next_count=1
  for ((index = 0; index < pending_state_count && next_count < 3; index += 1)); do
    if [[ "${pending_state_images[$index]}" != "$pending_alternate_image" ]]; then
      next_protocols[$next_count]="${pending_state_protocols[$index]}"; next_shas[$next_count]="${pending_state_shas[$index]}"
      next_images[$next_count]="${pending_state_images[$index]}"; next_contracts[$next_count]="${pending_state_contracts[$index]}"
      next_count=$((next_count + 1))
    fi
  done
  write_next_state
}

clear_pending() { rm -f -- "$pending_file"; }

recover_pending() {
  local load_result desired='original'
  if load_pending; then :; else load_result=$?; [[ $load_result -eq 2 ]] && return 0; return 1; fi
  recovery_active=1
  if [[ "$pending_operation" == deploy && $state_count -gt 0 && "${state_images[0]}" == "$pending_alternate_image" ]]; then
    desired='alternate'
  elif [[ "$pending_operation" == rehearsal \
    && ( "$pending_phase" == fallback || ( $state_count -gt 0 && "${state_images[0]}" == "$pending_alternate_image" ) ) ]]; then
    desired='alternate'
  fi
  if [[ "$desired" == alternate ]]; then
    replace_service "$pending_alternate_image" "$pending_alternate_contract" && service_is_healthy "$pending_alternate_image" || return 1
    if [[ "$pending_operation" == rehearsal ]]; then
      promote_pending_alternate || return 1
      ensure_pending_rehearsal_failure || return 1
    elif [[ $state_count -eq 0 || "${state_images[0]}" != "$pending_alternate_image" ]]; then return 1; fi
    if [[ "$pending_operation" == deploy ]]; then ensure_pending_deploy_record success none || return 1; fi
  else
    replace_service "$pending_original_image" "$pending_original_contract" && service_is_healthy "$pending_original_image" \
      && restore_pending_state || return 1
    if [[ "$pending_operation" == deploy ]]; then
      if [[ "$pending_original_image" =~ $legacy_pattern ]]; then
        ensure_pending_deploy_record rolled_back legacy_local || return 1
      else
        ensure_pending_deploy_record rolled_back saved_digest || return 1
      fi
    elif [[ "$pending_phase" == current_restored ]]; then
      ensure_consumed_file || return 1
    fi
  fi
  clear_pending || return 1
  recovery_active=0
}

test_boundary() {
  local point="$1"
  [[ $test_mode -eq 1 ]] || return 0
  if [[ "${MINORI_TEST_CRASH_AT:-}" == "$point" ]]; then kill -KILL "$$"; fi
  if [[ "${MINORI_TEST_INTERRUPT_AT:-}" == "$point" ]]; then kill -TERM "$$"; fi
}

restore_active_transaction() {
  replace_service "$original_image" "$original_contract" && service_is_healthy "$original_image" \
    && restore_original_state && clear_pending
}

journal_failure() {
  if restore_active_transaction; then
    transaction_active=0
    finish journal_failed_restored 1
  fi
  finish journal_failed_recovery_failed 1
}

on_signal() { exit 143; }
on_exit() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  set +e
  if [[ $terminal_emitted -eq 0 ]]; then
    if [[ $transaction_active -eq 1 ]]; then
      if restore_active_transaction; then printf 'minori_rehearsal result=interrupted_restored\n'; else printf 'minori_rehearsal result=interrupted_recovery_failed\n'; fi
    elif [[ $recovery_active -eq 1 ]]; then
      printf 'minori_rehearsal result=recovery_failed\n'
    fi
  fi
  cleanup
  exit "$exit_code"
}
trap on_signal HUP INT TERM
trap on_exit EXIT

if ! trusted_directory_is_valid "$minori_root" || ! trusted_directory_is_valid "$release_dir" \
  || ! trusted_directory_is_valid "$contracts_dir" || ! root_only_file_is_valid "$env_file" || ! lark_directory_is_valid; then
  finish rejected 2
fi
prepare_trusted_directory "$records_dir" && prepare_trusted_directory "$rehearsal_records_dir" || finish rejected 2
temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/minori-rehearsal.XXXXXX")" || finish rejected 2
reset_state
load_state || finish rejected 2
if ! recover_pending; then finish recovery_failed 1; fi
reset_state
load_state || finish rejected 2
[[ $state_count -ge 2 ]] || finish rejected 2
[[ "${state_shas[0]}" == "$expected_sha" && "${state_images[0]}" == "$expected_image" ]] || finish rejected 2
[[ "${state_images[0]}" =~ $digest_pattern ]] || finish rejected 2
[[ "$expected_sha" == "$transition_sha" && "$expected_image" == "$transition_image" \
  && "${state_shas[1]}" == "$predecessor_sha" && "${state_images[1]}" == "$predecessor_image" ]] || finish rejected 2
if [[ -e "$consumed_file" || -L "$consumed_file" ]]; then
  consumed_file_is_valid || finish rejected 2
  finish rejected 2
fi
running_image_equals "$expected_image" || finish rejected 2

original_sha="${state_shas[0]}"
original_image="${state_images[0]}"
original_contract="${state_contracts[0]}"
pending_operation='rehearsal'
pending_phase='prepared'
pending_original_protocol='v1'
pending_original_sha="$original_sha"
pending_original_image="$original_image"
pending_original_contract="$original_contract"
pending_alternate_protocol='v1'
pending_alternate_sha="${state_shas[1]}"
pending_alternate_image="${state_images[1]}"
pending_alternate_contract="${state_contracts[1]}"
initialize_pending_record_identity || finish failed_before_switch 1
write_pending "$pending_operation" "$pending_phase" "$pending_original_protocol" "$pending_original_sha" \
  "$pending_original_image" "$pending_original_contract" "$pending_alternate_protocol" "$pending_alternate_sha" \
  "$pending_alternate_image" "$pending_alternate_contract" || finish failed_before_switch 1
load_pending || finish failed_before_switch 1
transaction_active=1
test_boundary after_rehearsal_journal

if ! replace_service "$pending_alternate_image" "$pending_alternate_contract" \
  || ! service_is_healthy "$pending_alternate_image"; then
  update_pending_phase restoring_current || journal_failure
  if restore_active_transaction; then
    transaction_active=0
    finish predecessor_unhealthy_restored 1
  fi
  finish predecessor_unhealthy_restore_failed 1
fi
update_pending_phase predecessor_proven || journal_failure
test_boundary after_predecessor_switch
update_pending_phase restoring_current || journal_failure

if replace_service "$original_image" "$original_contract" && service_is_healthy "$original_image"; then
  test_boundary after_current_switch
  restore_original_state || journal_failure
  update_pending_phase current_restored || journal_failure
  ensure_consumed_file || journal_failure
  test_boundary after_consumed
  clear_pending || journal_failure
  transaction_active=0
  finish success 0
fi

update_pending_phase fallback || journal_failure
if replace_service "$pending_alternate_image" "$pending_alternate_contract" \
  && service_is_healthy "$pending_alternate_image"; then
  test_boundary after_fallback_switch
  if promote_pending_alternate; then
    test_boundary after_fallback_state
    if ensure_pending_rehearsal_failure && clear_pending; then
      transaction_active=0
      finish restore_failed_recovered_predecessor 1
    fi
  fi
fi
finish restore_failed_recovery_failed 1
