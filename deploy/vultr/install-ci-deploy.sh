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
if [[ "${MINORI_INSTALL_TEST_MODE:-}" == 1 && -n "${MINORI_INSTALL_TEST_ROOT:-}" ]]; then
  requested_test_root="$MINORI_INSTALL_TEST_ROOT"
  case "$requested_test_root" in
    /|/opt|/opt/minori|/root|/root/*)
      result_error unsafe_test_root 1
      ;;
  esac
  if [[ ! -d "$requested_test_root" || -L "$requested_test_root" || ! -O "$requested_test_root" ]]; then
    result_error unsafe_test_root 1
  fi
  test_root="$(cd "$requested_test_root" 2>/dev/null && pwd -P)" || result_error unsafe_test_root 1
  test_parent="${test_root%/*}"
  test_name="${test_root##*/}"
  case "$test_parent" in
    /tmp|/private/tmp|/private/var/folders/*/*/T) ;;
    *) result_error unsafe_test_root 1 ;;
  esac
  [[ "$test_name" == minori-installer-test-* ]] || result_error unsafe_test_root 1
  test_mode=1
  expected_uid="$(id -u)"
  expected_gid="$(id -g)"
  fixture_sentinel="${test_root}/.minori-ci-installer-test"
  opt_parent="${test_root}/opt"
  root_parent="${test_root}/root"
  install_root="${opt_parent}/minori"
  ssh_dir="${root_parent}/.ssh"
  sshd_config_dir="${test_root}/etc/ssh/sshd_config.d"
elif [[ $EUID -eq 0 && -z "${MINORI_INSTALL_TEST_MODE:-}" && -z "${MINORI_INSTALL_TEST_ROOT:-}" ]]; then
  install_root='/opt/minori'
  ssh_dir='/root/.ssh'
  sshd_config_dir='/etc/ssh/sshd_config.d'
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
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="${install_root}/bin"
libexec_dir="${install_root}/libexec"
release_dir="${install_root}/releases"
rehearsal_consumed="${release_dir}/rehearsal-v0.1.1.accepted"
authorized_keys="${ssh_dir}/authorized_keys"
sshd_policy="${sshd_config_dir}/00-minori-ci-deploy.conf"
forced_command="${bin_dir}/ci-deploy"
forced_prefix="restrict,command=\"${forced_command}\""
authorized_entry="${forced_prefix} ${public_key}"

if [[ $test_mode -eq 0 ]]; then
  if [[ ! -x /usr/sbin/sshd ]]; then
    result_error unsafe_sshd_environment 1
  fi
  effective_before="$(/usr/sbin/sshd -T -C user=root,host=minori-ci-deploy.invalid,addr=127.0.0.1 2>/dev/null)" \
    || result_error unsafe_sshd_environment 1
  if [[ "$(awk '$1 == "permituserenvironment" { print $2 }' <<< "$effective_before")" != no ]]; then
    result_error unsafe_sshd_environment 1
  fi
fi

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
  sentinel_mode="$(path_metadata "$fixture_sentinel")" || result_error unsafe_test_root 1
  read -r sentinel_lines _ <<< "$(wc -l < "$fixture_sentinel" 2>/dev/null)" || result_error unsafe_test_root 1
  if [[ ! -f "$fixture_sentinel" || -L "$fixture_sentinel" || "$sentinel_mode" != "$expected_uid $expected_gid 600" \
    || "$sentinel_lines" != 1 || "$(<"$fixture_sentinel")" != minori-ci-installer-test-v1 ]]; then
    result_error unsafe_test_root 1
  fi
  trusted_components=("$test_root" "$fixture_sentinel" "$opt_parent" "$root_parent" "${test_root}/etc" \
    "${test_root}/etc/ssh" "$sshd_config_dir" "$sshd_policy")
else
  trusted_components=(/opt /root /etc /etc/ssh "$sshd_config_dir" "$sshd_policy")
fi
trusted_components+=("$install_root" "$bin_dir" "$libexec_dir" "$release_dir" "$rehearsal_consumed" "$ssh_dir" "$authorized_keys" \
  "${bin_dir}/ci-deploy" "${bin_dir}/minori-release" "${bin_dir}/rehearse-release" \
  "${libexec_dir}/ci-deploy" "${libexec_dir}/minori-release" "${libexec_dir}/rehearse-release")
for secure_path in "${trusted_components[@]}"; do
  if [[ -L "$secure_path" ]] || { [[ -e "$secure_path" ]] && ! verify_secure_path "$secure_path"; }; then
    result_error unsafe_installation 1
  fi
done

if [[ -e "$sshd_policy" ]] && ! cmp -s -- "${script_dir}/sshd-minori-ci-deploy.conf" "$sshd_policy"; then
  result_error unsafe_sshd_environment 1
fi

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
  if [[ "$existing_line" == *"command=\"${forced_command}\""* ]]; then
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
install_directory 0755 "$libexec_dir"
install_directory 0755 "$release_dir"
if [[ $test_mode -eq 1 ]]; then
  install_directory 0755 "${test_root}/etc"
  install_directory 0755 "${test_root}/etc/ssh"
fi
install_directory 0755 "$sshd_config_dir"
install_file 0755 "${script_dir}/clean-entrypoint.py" "${bin_dir}/ci-deploy"
install_file 0755 "${script_dir}/clean-entrypoint.py" "${bin_dir}/minori-release"
install_file 0755 "${script_dir}/clean-entrypoint.py" "${bin_dir}/rehearse-release"
install_file 0700 "${script_dir}/ci-deploy" "${libexec_dir}/ci-deploy"
install_file 0700 "${script_dir}/minori-release" "${libexec_dir}/minori-release"
install_file 0700 "${script_dir}/rehearse-release.sh" "${libexec_dir}/rehearse-release"
install_file 0600 "${script_dir}/rehearsal-v0.1.1.accepted" "$rehearsal_consumed"
if [[ -e "$sshd_policy" ]]; then
  if [[ ! -f "$sshd_policy" || -L "$sshd_policy" ]] || ! cmp -s -- "${script_dir}/sshd-minori-ci-deploy.conf" "$sshd_policy"; then
    result_error unsafe_sshd_environment 1
  fi
else
  install_file 0644 "${script_dir}/sshd-minori-ci-deploy.conf" "$sshd_policy"
fi
post_install_paths=("$install_root" "$bin_dir" "$libexec_dir" "$release_dir" "$rehearsal_consumed" "${bin_dir}/ci-deploy" \
  "${bin_dir}/minori-release" "${bin_dir}/rehearse-release" "${libexec_dir}/ci-deploy" \
  "${libexec_dir}/minori-release" "${libexec_dir}/rehearse-release" "$sshd_config_dir" "$sshd_policy")
if [[ $test_mode -eq 1 ]]; then
  post_install_paths=("$opt_parent" "$root_parent" "${test_root}/etc" "${test_root}/etc/ssh" "${post_install_paths[@]}")
fi
for secure_path in "${post_install_paths[@]}"; do
  if ! verify_secure_path "$secure_path"; then
    result_error unsafe_installation 1
  fi
done

if [[ $test_mode -eq 0 ]]; then
  /usr/sbin/sshd -t || result_error unsafe_sshd_environment 1
  effective_after="$(/usr/sbin/sshd -T -C user=root,host=minori-ci-deploy.invalid,addr=127.0.0.1 2>/dev/null)" \
    || result_error unsafe_sshd_environment 1
  mapfile -t accepted_environment < <(awk '$1 == "acceptenv" { for (i = 2; i <= NF; i += 1) print $i }' <<< "$effective_after")
  mapfile -t fixed_environment < <(awk '$1 == "setenv" { for (i = 2; i <= NF; i += 1) print $i }' <<< "$effective_after")
  if [[ "${accepted_environment[*]}" != 'LANG LC_*' \
    || " ${fixed_environment[*]} " != *' BASH_ENV=/dev/null '* \
    || " ${fixed_environment[*]} " != *' ENV=/dev/null '* ]]; then
    result_error unsafe_sshd_environment 1
  fi
  /usr/bin/systemctl reload ssh.service || result_error sshd_reload_failed 1
fi

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
