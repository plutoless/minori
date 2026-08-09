import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const shaA = 'a'.repeat(40);
export const shaB = 'b'.repeat(40);
export const shaC = 'c'.repeat(40);
export const shaD = 'd'.repeat(40);
export const digestA = `ghcr.io/plutoless/minori@sha256:${'1'.repeat(64)}`;
export const digestB = `ghcr.io/plutoless/minori@sha256:${'2'.repeat(64)}`;
export const digestC = `ghcr.io/plutoless/minori@sha256:${'3'.repeat(64)}`;
export const digestD = `ghcr.io/plutoless/minori@sha256:${'4'.repeat(64)}`;

const fakeDocker = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf 'image=%s :: %s\n' "\${MINORI_IMAGE-}" "$*" >> "$FAKE_RUNTIME_LOG/docker.log"

next_sequence_value() {
  local name="$1"
  local counter_file="$FAKE_RUNTIME_LOG/\${name}.count"
  local count=0 sequence value
  if [[ -r "$counter_file" ]]; then count="$(<"$counter_file")"; fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$counter_file"
  if [[ "$name" == compose-up ]]; then
    sequence="\${FAKE_COMPOSE_UP_SEQUENCE:-1}"
  else
    sequence="1"
  fi
  value="$(printf '%s' "$sequence" | cut -d, -f"$count")"
  if [[ -z "$value" ]]; then value="$(printf '%s' "$sequence" | awk -F, '{print $NF}')"; fi
  [[ "$value" == 1 ]]
}

if [[ "\${1:-}" == inspect && "\${2:-}" == --format ]]; then
  if [[ -z "\${FAKE_CURRENT_IMAGE:-}" ]]; then exit 1; fi
  printf '%s\n' "$FAKE_CURRENT_IMAGE"
  exit 0
fi
if [[ "\${1:-}" == pull ]]; then
  [[ "\${FAKE_FAIL:-}" != pull ]]
  exit
fi
if [[ "\${1:-}" == image && "\${2:-}" == inspect ]]; then
  if [[ "\${3:-}" != --format ]]; then
    [[ "\${FAKE_FAIL:-}" != image_missing ]]
    exit
  fi
  target_image="\${5:-}"
  case "$target_image" in
    minori:*) mapped_revision="\${target_image#minori:}" ;;
    *sha256:1111111111111111111111111111111111111111111111111111111111111111) mapped_revision="$FAKE_SHA_A" ;;
    *sha256:2222222222222222222222222222222222222222222222222222222222222222) mapped_revision="$FAKE_SHA_B" ;;
    *sha256:3333333333333333333333333333333333333333333333333333333333333333) mapped_revision="$FAKE_SHA_C" ;;
    *sha256:4444444444444444444444444444444444444444444444444444444444444444) mapped_revision="$FAKE_SHA_D" ;;
    *) mapped_revision='' ;;
  esac
  if [[ "$target_image" == "$FAKE_REQUEST_IMAGE" ]]; then
    revision="\${FAKE_REVISION:-$mapped_revision}"
    architecture="\${FAKE_ARCHITECTURE:-amd64}"
    user="\${FAKE_USER:-10001:10001}"
    repository_digest="\${FAKE_REPO_DIGEST:-$target_image}"
  else
    revision="$mapped_revision"
    architecture=amd64
    user='10001:10001'
    repository_digest="$target_image"
  fi
  case "\${4:-}" in
    *revision*) printf '%s\n' "$revision" ;;
    *Architecture*) printf '%s\n' "$architecture" ;;
    *Config.User*) printf '%s\n' "$user" ;;
    *RepoDigests*) printf '%s\n' "$repository_digest" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == image && "\${2:-}" == rm ]]; then
  [[ "\${FAKE_FAIL:-}" != prune ]]
  exit
fi
if [[ "\${1:-}" == create ]]; then
  printf '%s\n' "\${2:-}" > "$FAKE_RUNTIME_LOG/container.image"
  printf 'fake-container\n'
  exit 0
fi
if [[ "\${1:-}" == cp ]]; then
  destination="\${3:-}"
  if [[ "\${2:-}" == *deployment-protocol ]]; then
    container_image="$(<"$FAKE_RUNTIME_LOG/container.image")"
    if [[ "$container_image" == "$FAKE_REQUEST_IMAGE" ]]; then
      printf '%s\n' "\${FAKE_PROTOCOL:-v1}" > "$destination"
    else
      printf 'v1\n' > "$destination"
    fi
  elif [[ "\${2:-}" == *compose.production.yaml ]]; then
    printf '%s\n' 'services:' '  app:' '    image: \${MINORI_IMAGE:?MINORI_IMAGE is required}' > "$destination"
  else
    exit 1
  fi
  exit 0
fi
if [[ "\${1:-}" == rm ]]; then exit 0; fi
if [[ "\${1:-}" == run ]]; then
  case "$*" in
    *runtime:verify*) [[ "\${FAKE_FAIL:-}" != preflight ]] ;;
    *db:migrate*) [[ "\${FAKE_FAIL:-}" != migration ]] ;;
    *) true ;;
  esac
  exit
fi
if [[ "\${1:-}" == compose ]]; then
  case "$*" in
    *'config --images'*)
      if [[ "$MINORI_IMAGE" == "$FAKE_REQUEST_IMAGE" ]]; then
        printf '%s\n' "\${FAKE_COMPOSE_IMAGE:-$MINORI_IMAGE}"
      else
        printf '%s\n' "\${FAKE_SAVED_COMPOSE_IMAGE:-$MINORI_IMAGE}"
      fi
      ;;
    *'up -d --no-build'*) next_sequence_value compose-up ;;
    *) exit 1 ;;
  esac
  exit
fi
exit 1
`.replaceAll('\\${', '${');

const fakeCurl = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_RUNTIME_LOG/curl.log"
counter_file="$FAKE_RUNTIME_LOG/curl.count"
count=0
if [[ -r "$counter_file" ]]; then count="$(<"$counter_file")"; fi
count=$((count + 1))
printf '%s\n' "$count" > "$counter_file"
sequence="\${FAKE_READY_SEQUENCE:-1}"
value="$(printf '%s' "$sequence" | cut -d, -f"$count")"
if [[ -z "$value" ]]; then value="$(printf '%s' "$sequence" | awk -F, '{print $NF}')"; fi
[[ "$value" == 1 ]]
`.replaceAll('\\${', '${');

const fakeFlock = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_RUNTIME_LOG/flock.log"
[[ "\${FAKE_LOCKED:-0}" != 1 ]]
`.replaceAll('\\${', '${');

const fakeInstall = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_RUNTIME_LOG/install.log"
mode=600
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) mode="$2"; shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[[ $# -eq 2 ]]
mkdir -p "$(dirname "$2")"
cp "$1" "$2"
chmod "$mode" "$2"
`;

const fakeDate = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_RUNTIME_LOG/date.log"
if [[ "\${FAKE_DATE_FAIL:-0}" == 1 ]]; then exit 1; fi
printf '2026-08-09T12:34:56Z\n'
`.replaceAll('\\${', '${');

const fakeSleep = String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_RUNTIME_LOG/sleep.log"
`;

async function executable(path: string, body: string) {
  await writeFile(path, body);
  await chmod(path, 0o755);
}

export async function createFakeDeployRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'minori-deploy-test-'));
  const root = join(directory, 'opt', 'minori');
  const bin = join(directory, 'fake-bin');
  const log = join(directory, 'log');
  await Promise.all([
    mkdir(join(root, 'bin'), { recursive: true }),
    mkdir(join(root, 'release'), { recursive: true }),
    mkdir(join(root, 'releases', 'contracts'), { recursive: true }),
    mkdir(join(root, 'releases', 'records'), { recursive: true }),
    mkdir(join(root, 'lark'), { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(log, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'minori.env'), 'DATABASE_URL=postgres://redacted\n', { mode: 0o600 }),
    writeFile(join(root, 'release', 'deployment-protocol'), 'v1\n'),
    writeFile(
      join(root, 'releases', `${shaB}.compose.yaml`),
      'services:\n  app:\n    image: ${MINORI_IMAGE}\n',
    ),
    executable(join(bin, 'docker'), fakeDocker),
    executable(join(bin, 'curl'), fakeCurl),
    executable(join(bin, 'flock'), fakeFlock),
    executable(join(bin, 'install'), fakeInstall),
    executable(join(bin, 'date'), fakeDate),
    executable(join(bin, 'sleep'), fakeSleep),
  ]);
  await chmod(join(root, 'lark'), 0o750);

  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    MINORI_TEST_ROOT: root,
    FAKE_RUNTIME_LOG: log,
    FAKE_REQUEST_SHA: shaA,
    FAKE_REQUEST_IMAGE: digestA,
    FAKE_CURRENT_IMAGE: `minori:${shaB}`,
    FAKE_SHA_A: shaA,
    FAKE_SHA_B: shaB,
    FAKE_SHA_C: shaC,
    FAKE_SHA_D: shaD,
    MINORI_READY_ATTEMPTS: '1',
    MINORI_READY_DELAY_SECONDS: '0',
  };

  return {
    directory,
    root,
    bin,
    log,
    env,
    async logText(name: string) {
      try {
        return await readFile(join(log, name), 'utf8');
      } catch {
        return '';
      }
    },
    async installFakeReleaseEngine(body = '#!/usr/bin/env bash\nexit 0\n') {
      await executable(join(root, 'bin', 'minori-release'), body);
    },
    async writeContract(sha: string, body = 'services:\n  app:\n    image: ${MINORI_IMAGE}\n') {
      const path = join(root, 'releases', `${sha}.compose.yaml`);
      await writeFile(path, body);
      return path;
    },
    async writeDigestContract(digest: string, body = 'services:\n  app:\n    image: ${MINORI_IMAGE}\n') {
      const path = join(root, 'releases', 'contracts', `${digest.split(':')[1]}.compose.yaml`);
      await writeFile(path, body);
      return path;
    },
    async writeState(rows: Array<[string, string, string, string]>) {
      const path = join(root, 'releases', 'state.tsv');
      await writeFile(path, `${rows.map((row) => row.join('\t')).join('\n')}\n`, { mode: 0o600 });
      return path;
    },
  };
}
