#!/bin/bash
set -euo pipefail
umask 077
LC_ALL=C
LANG=C
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export LC_ALL LANG PATH

result_error() {
  printf 'minori_ci_install result=%s\n' "$1" >&2
  exit "$2"
}

if [[ $# -ne 1 ]]; then
  printf 'usage: install-ci-deploy.sh <deployment-ed25519-public-key-file>\n' >&2
  exit 2
fi

test_mode=0
expected_uid=0
expected_gid=0
if [[ "${MINORI_INSTALL_TEST_MODE:-}" == 1 && -n "${MINORI_INSTALL_TEST_ROOT:-}" \
  && -d "$MINORI_INSTALL_TEST_ROOT" \
  && ! -L "$MINORI_INSTALL_TEST_ROOT" && -O "$MINORI_INSTALL_TEST_ROOT" ]]; then
  test_mode=1
  expected_uid="$(id -u)"
  expected_gid="$(id -g)"
  install_root="${MINORI_INSTALL_TEST_ROOT}/opt/minori"
  ssh_dir="${MINORI_INSTALL_TEST_ROOT}/root/.ssh"
elif [[ $EUID -eq 0 && -z "${MINORI_INSTALL_TEST_MODE:-}" && -z "${MINORI_INSTALL_TEST_ROOT:-}" ]]; then
  install_root='/opt/minori'
  ssh_dir='/root/.ssh'
else
  result_error root_required 1
fi

public_key_file="$1"
if [[ ! -f "$public_key_file" || -L "$public_key_file" || ! -r "$public_key_file" ]]; then
  result_error invalid_key 2
fi
public_key=''
line_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  public_key="$line"
  line_count=$((line_count + 1))
done < "$public_key_file"
if [[ $line_count -ne 1 ]]; then
  result_error invalid_key 2
fi
if [[ ! "$public_key" =~ ^ssh-ed25519\ [ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/]+={0,3}([[:space:]][^[:cntrl:]]+)?$ ]]; then
  result_error invalid_key 2
fi
if ! ssh-keygen -l -f "$public_key_file" >/dev/null 2>&1; then
  result_error invalid_key 2
fi

read -r key_type key_blob _ <<< "$public_key"
forced_prefix='restrict,command="/opt/minori/bin/ci-deploy"'
authorized_entry="${forced_prefix} ${public_key}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${install_root}/bin"
authorized_keys="${ssh_dir}/authorized_keys"

path_metadata() {
  local path="$1"
  local metadata
  if metadata="$(stat -c '%u %g %a' -- "$path" 2>/dev/null)"; then
    printf '%s\n' "$metadata"
    return 0
  fi
  stat -f '%u %g %Lp' -- "$path" 2>/dev/null
}

verify_secure_path() {
  local path="$1"
  local metadata owner group mode
  [[ -e "$path" && ! -L "$path" ]] || return 1
  metadata="$(path_metadata "$path")" || return 1
  read -r owner group mode <<< "$metadata"
  [[ "$owner" == "$expected_uid" && "$group" == "$expected_gid" && "$mode" =~ ^[01234567]{3,4}$ ]] \
    || return 1
  (( (8#$mode & 8#022) == 0 ))
}

install_directory() {
  local mode="$1"
  local path="$2"
  if [[ $test_mode -eq 1 ]]; then
    install -d -m "$mode" "$path"
  else
    install -d -m "$mode" -o root -g root "$path"
  fi
}

install_file() {
  local mode="$1"
  local source="$2"
  local destination="$3"
  if [[ $test_mode -eq 1 ]]; then
    install -m "$mode" -- "$source" "$destination"
  else
    install -m "$mode" -o root -g root -- "$source" "$destination"
  fi
}

# Resolve every trusted component and installed leaf before any directory,
# authorized_keys, or executable is changed. stat alone would follow symlinks.
if [[ $test_mode -eq 1 ]]; then
  trusted_components=("$MINORI_INSTALL_TEST_ROOT")
else
  trusted_components=(/opt /root)
fi
trusted_components+=("$install_root" "$bin_dir" "$ssh_dir" "$authorized_keys" \
  "${bin_dir}/ci-deploy" "${bin_dir}/minori-release" "${bin_dir}/rehearse-release")
for secure_path in "${trusted_components[@]}"; do
  if [[ -L "$secure_path" ]] || { [[ -e "$secure_path" ]] && ! verify_secure_path "$secure_path"; }; then
    result_error unsafe_installation 1
  fi
done

install_directory 0700 "$ssh_dir"
if [[ ! -e "$authorized_keys" ]]; then
  install_file 0600 /dev/null "$authorized_keys"
fi
if [[ ! -f "$authorized_keys" || -L "$authorized_keys" || ! -r "$authorized_keys" ]]; then
  result_error invalid_authorized_keys 1
fi

forced_count=0
same_key_count=0
exact_count=0
while IFS= read -r existing_line || [[ -n "$existing_line" ]]; do
  if [[ "$existing_line" == *'command="/opt/minori/bin/ci-deploy"'* ]]; then
    forced_count=$((forced_count + 1))
  fi
  if [[ "$existing_line" == *"${key_type} ${key_blob}"* ]]; then
    same_key_count=$((same_key_count + 1))
  fi
  if [[ "$existing_line" == "$authorized_entry" ]]; then
    exact_count=$((exact_count + 1))
  fi
done < "$authorized_keys"

if [[ $forced_count -gt 1 || $same_key_count -gt 1 || $exact_count -gt 1 \
  || ( $forced_count -eq 1 && $exact_count -ne 1 ) \
  || ( $same_key_count -eq 1 && $exact_count -ne 1 ) ]]; then
  result_error ambiguous_deployment_key 1
fi

install_directory 0755 "$install_root"
install_directory 0755 "$bin_dir"
install_file 0755 "${script_dir}/ci-deploy" "${bin_dir}/ci-deploy"
install_file 0755 "${script_dir}/minori-release" "${bin_dir}/minori-release"
install_file 0755 "${script_dir}/rehearse-release.sh" "${bin_dir}/rehearse-release"
for secure_path in "$install_root" "$bin_dir" "${bin_dir}/ci-deploy" \
  "${bin_dir}/minori-release" "${bin_dir}/rehearse-release"; do
  if ! verify_secure_path "$secure_path"; then
    result_error unsafe_installation 1
  fi
done

if [[ $exact_count -eq 0 ]]; then
  temporary_keys="$(mktemp "${ssh_dir}/authorized_keys.tmp.XXXXXX")"
  cleanup_keys() {
    rm -f -- "$temporary_keys"
  }
  trap cleanup_keys EXIT
  if ! cp -- "$authorized_keys" "$temporary_keys"; then
    result_error authorized_keys_write_failed 1
  fi
  if [[ -s "$temporary_keys" && "$(tail -c 1 "$temporary_keys" | wc -l)" -eq 0 ]]; then
    printf '\n' >> "$temporary_keys"
  fi
  printf '%s\n' "$authorized_entry" >> "$temporary_keys"
  if [[ $test_mode -eq 0 ]]; then
    chown root:root "$temporary_keys"
  fi
  chmod 0600 "$temporary_keys"
  mv -f -- "$temporary_keys" "$authorized_keys"
  trap - EXIT
fi

if ! verify_secure_path "$ssh_dir" || ! verify_secure_path "$authorized_keys"; then
  result_error unsafe_authorized_keys 1
fi
printf 'minori_ci_install result=success\n'
