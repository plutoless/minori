#!/bin/bash
set -euo pipefail
umask 077
PATH='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
export PATH

if [[ $# -ne 1 ]]; then
  printf 'usage: install-ci-deploy.sh <deployment-ed25519-public-key-file>\n' >&2
  exit 2
fi
if [[ $EUID -ne 0 ]]; then
  printf 'minori_ci_install result=root_required\n' >&2
  exit 1
fi

public_key_file="$1"
if [[ ! -f "$public_key_file" || ! -r "$public_key_file" ]]; then
  printf 'minori_ci_install result=invalid_key\n' >&2
  exit 2
fi
mapfile -t public_key_lines < "$public_key_file"
if [[ ${#public_key_lines[@]} -ne 1 ]]; then
  printf 'minori_ci_install result=invalid_key\n' >&2
  exit 2
fi
public_key="${public_key_lines[0]}"
if [[ ! "$public_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,3}([[:space:]][^[:cntrl:]]+)?$ ]]; then
  printf 'minori_ci_install result=invalid_key\n' >&2
  exit 2
fi
if ! ssh-keygen -l -f "$public_key_file" >/dev/null 2>&1; then
  printf 'minori_ci_install result=invalid_key\n' >&2
  exit 2
fi

read -r key_type key_blob _ <<< "$public_key"
forced_prefix='restrict,command="/opt/minori/bin/ci-deploy"'
authorized_entry="${forced_prefix} ${public_key}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install_root='/opt/minori'
bin_dir="${install_root}/bin"
ssh_dir='/root/.ssh'
authorized_keys="${ssh_dir}/authorized_keys"

verify_secure_path() {
  local path="$1"
  local metadata owner group mode
  if ! metadata="$(stat -c '%u %g %a' -- "$path")"; then
    return 1
  fi
  read -r owner group mode <<< "$metadata"
  [[ "$owner" == 0 && "$group" == 0 ]] || return 1
  (( (8#$mode & 8#022) == 0 ))
}

if [[ -e "$install_root" ]] && ! verify_secure_path "$install_root"; then
  printf 'minori_ci_install result=unsafe_installation\n' >&2
  exit 1
fi

install -d -m 0700 -o root -g root "$ssh_dir"
if [[ ! -e "$authorized_keys" ]]; then
  install -m 0600 -o root -g root /dev/null "$authorized_keys"
fi
if [[ ! -f "$authorized_keys" || -L "$authorized_keys" || ! -r "$authorized_keys" ]]; then
  printf 'minori_ci_install result=invalid_authorized_keys\n' >&2
  exit 1
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
  printf 'minori_ci_install result=ambiguous_deployment_key\n' >&2
  exit 1
fi

if [[ ! -d "$install_root" ]]; then
  install -d -m 0755 -o root -g root "$install_root"
fi
install -d -m 0755 -o root -g root "$bin_dir"
install -m 0755 -o root -g root -- "${script_dir}/ci-deploy" "${bin_dir}/ci-deploy"
install -m 0755 -o root -g root -- "${script_dir}/minori-release" "${bin_dir}/minori-release"
install -m 0755 -o root -g root -- "${script_dir}/rehearse-release.sh" "${bin_dir}/rehearse-release"
for secure_path in "$install_root" "$bin_dir" "${bin_dir}/ci-deploy" "${bin_dir}/minori-release" "${bin_dir}/rehearse-release"; do
  if ! verify_secure_path "$secure_path"; then
    printf 'minori_ci_install result=unsafe_installation\n' >&2
    exit 1
  fi
done

if [[ $exact_count -eq 0 ]]; then
  temporary_keys="$(mktemp "${ssh_dir}/authorized_keys.tmp.XXXXXX")"
  cleanup_keys() {
    rm -f -- "$temporary_keys"
  }
  trap cleanup_keys EXIT
  if ! cp -- "$authorized_keys" "$temporary_keys"; then
    printf 'minori_ci_install result=authorized_keys_write_failed\n' >&2
    exit 1
  fi
  if [[ -s "$temporary_keys" && "$(tail -c 1 "$temporary_keys" | wc -l)" -eq 0 ]]; then
    printf '\n' >> "$temporary_keys"
  fi
  printf '%s\n' "$authorized_entry" >> "$temporary_keys"
  chown root:root "$temporary_keys"
  chmod 0600 "$temporary_keys"
  mv -f -- "$temporary_keys" "$authorized_keys"
  trap - EXIT
fi

if ! verify_secure_path "$ssh_dir" || ! verify_secure_path "$authorized_keys"; then
  printf 'minori_ci_install result=unsafe_authorized_keys\n' >&2
  exit 1
fi
printf 'minori_ci_install result=success\n'
