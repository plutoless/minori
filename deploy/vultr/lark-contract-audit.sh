#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '%s\n' 'minori_lark_contract_audit result=failed' >&2
  exit 1
}

[[ "$#" -eq 4 ]] || fail
image="$1"
expected_revision="$2"
source_root="$3"
input_file="$4"
lark_root='/opt/minori/lark'
audit_root='/opt/minori/contract-audit'

[[ "$EUID" -eq 0 ]] || fail
[[ "$image" =~ ^ghcr.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]] || fail
[[ "$expected_revision" =~ ^[a-f0-9]{40}$ ]] || fail
[[ "$source_root" == /* && -d "$source_root" && ! -L "$source_root" ]] || fail
[[ "$(stat -c '%u' "$source_root")" == '0' ]] || fail
source_mode="$(stat -c '%a' "$source_root")"
(( (8#$source_mode & 8#022) == 0 )) || fail
[[ -d "$lark_root" && ! -L "$lark_root" ]] || fail
[[ -d "$audit_root" && ! -L "$audit_root" ]] || fail
[[ -f "$input_file" && ! -L "$input_file" ]] || fail
[[ "$(stat -c '%u:%g:%a' "$audit_root")" == '0:0:700' ]] || fail
[[ "$(stat -c '%u:%g:%a' "$input_file")" == '0:0:600' ]] || fail
for source_file in \
  "$source_root/scripts/lark-contract-audit.ts" \
  "$source_root/scripts/lark-contract-manifest.ts" \
  "$source_root/scripts/lark-contract-sanitizer.ts"; do
  [[ -f "$source_file" && ! -L "$source_file" && "$(stat -c '%u' "$source_file")" == '0' ]] || fail
  source_mode="$(stat -c '%a' "$source_file")"
  (( (8#$source_mode & 8#022) == 0 )) || fail
done
[[ -d "$source_root/src" && ! -L "$source_root/src" ]] || fail

image_revision="$(docker image inspect "$image" \
  --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' 2>/dev/null)" || fail
image_arch="$(docker image inspect "$image" --format '{{.Architecture}}' 2>/dev/null)" || fail
image_user="$(docker image inspect "$image" --format '{{.Config.User}}' 2>/dev/null)" || fail
[[ "$image_revision" == "$expected_revision" ]] || fail
[[ "$image_arch" == 'amd64' ]] || fail
[[ "$image_user" == '10001:10001' ]] || fail

run_root="$(mktemp -d "$audit_root/run.XXXXXXXX")" || fail
chmod 0700 "$run_root"
state_candidate=''
cleanup() {
  if [[ -n "$state_candidate" ]]; then
    rm -f -- "$state_candidate"
  fi
  rm -rf -- "$run_root"
}
trap cleanup EXIT INT TERM HUP
install -d -m 0700 -o 10001 -g 10001 "$run_root/output"
docker_state_args=()
operator_state_args=()
if [[ -e "$audit_root/state.json" ]]; then
  [[ -f "$audit_root/state.json" && ! -L "$audit_root/state.json" ]] || fail
  [[ "$(stat -c '%u:%g:%a' "$audit_root/state.json")" == '0:0:600' ]] || fail
  install -m 0400 -o 10001 -g 10001 "$audit_root/state.json" "$run_root/state.json"
  docker_state_args=(--volume "$run_root/state.json:/run/minori-contract-state.json:ro")
  operator_state_args=(--state /run/minori-contract-state.json)
fi

operator_log="$run_root/operator.log"
if ! docker run --rm --interactive --read-only --user 10001:10001 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,mode=1777 \
  --env HOME=/var/lib/minori/lark/home \
  --env LARKSUITE_CLI_CONFIG_DIR=/var/lib/minori/lark/config \
  --env LARKSUITE_CLI_DATA_DIR=/var/lib/minori/lark/data \
  --env LARK_CLI_BIN=/app/node_modules/.bin/lark-cli \
  --volume /opt/minori/lark:/var/lib/minori/lark \
  --volume "$source_root/scripts/lark-contract-audit.ts:/app/scripts/lark-contract-audit.ts:ro" \
  --volume "$source_root/scripts/lark-contract-manifest.ts:/app/scripts/lark-contract-manifest.ts:ro" \
  --volume "$source_root/scripts/lark-contract-sanitizer.ts:/app/scripts/lark-contract-sanitizer.ts:ro" \
  --volume "$source_root/src:/app/src:ro" \
  --volume "$run_root/output:/run/minori-audit" \
  "${docker_state_args[@]}" \
  "$image" node --experimental-strip-types \
  /app/scripts/lark-contract-audit.ts --capture --output /run/minori-audit \
  --lockfile /app/package-lock.json \
  "${operator_state_args[@]}" \
  <"$input_file" >"$operator_log" 2>&1; then
  category="$(grep -E '^lark_contract_[a-z_]+$' "$operator_log" | tail -n 1 || true)"
  if [[ -n "$category" ]]; then
    printf 'minori_lark_contract_audit category=%s\n' "$category" >&2
  fi
  fail
fi

manifest_count="$(find "$run_root/output" -mindepth 2 -maxdepth 2 -type f -name manifest.json | wc -l)"
[[ -f "$run_root/output/report.json" && "$manifest_count" -eq 1 ]] || fail
[[ -z "$(find "$run_root/output" -type l -print -quit)" ]] || fail
[[ -z "$(find "$run_root/output" ! -type f ! -type d -print -quit)" ]] || fail
if [[ -e "$run_root/output/binding.secret" ]]; then
  [[ ! -e "$audit_root/state.json" ]] || fail
  [[ -f "$run_root/output/binding.secret" && ! -L "$run_root/output/binding.secret" ]] || fail
  python3 - "$run_root/output/binding.secret" <<'PY' || fail
import json
import pathlib
import sys

value = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))
if set(value) != {'documentToken'}:
    raise SystemExit(1)
token = value['documentToken']
if not isinstance(token, str) or not token or len(token) > 500 or any(ord(c) < 0x20 for c in token):
    raise SystemExit(1)
PY
  state_candidate="$(mktemp "$audit_root/.state.XXXXXXXX")" || fail
  install -m 0600 -o 0 -g 0 "$run_root/output/binding.secret" "$state_candidate"
  mv -f -- "$state_candidate" "$audit_root/state.json"
  state_candidate=''
  rm -f -- "$run_root/output/binding.secret"
fi
install -d -m 0700 "$audit_root/latest"
find "$audit_root/latest" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -a "$run_root/output/." "$audit_root/latest/"
chown -R 0:0 "$audit_root/latest"
find "$audit_root/latest" -type d -exec chmod 0700 {} +
find "$audit_root/latest" -type f -exec chmod 0600 {} +
printf '%s\n' 'minori_lark_contract_audit result=success'
