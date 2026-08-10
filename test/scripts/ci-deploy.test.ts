import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createFakeDeployRuntime,
  digestA,
  shaA,
} from './fake-deploy-runtime.js';

const execFileAsync = promisify(execFile);
const entrypoint = 'deploy/vultr/ci-deploy';
const installer = 'deploy/vultr/install-ci-deploy.sh';

async function run(
  runtime: Awaited<ReturnType<typeof createFakeDeployRuntime>>,
  command: string | undefined,
  args: string[] = [],
  extraEnv: NodeJS.ProcessEnv = {},
) {
  try {
    const result = await execFileAsync(entrypoint, args, {
      env: {
        ...runtime.env,
        ...extraEnv,
        ...(command === undefined ? { SSH_ORIGINAL_COMMAND: undefined } : { SSH_ORIGINAL_COMMAND: command }),
      },
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

describe('restricted forced-command parser', { timeout: 15_000 }, () => {
  it('passes one completely validated Deployment Protocol v1 request to the release engine', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_RUNTIME_LOG/release.log"
printf 'minori_release result=success active_sha=${shaA} active_image=${digestA}\\n'
`,
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({
      code: 0,
      stdout: `minori_deploy result=success active_sha=${shaA} active_image=${digestA}\n`,
      stderr: '',
    }));
    expect(await runtime.logText('release.log')).toBe(`v1 ${shaA} ${digestA}\n`);
  });

  it.each([
    ['missing command', undefined],
    ['empty command', ''],
    ['missing digest', `deploy v1 ${shaA}`],
    ['extra argument', `deploy v1 ${shaA} ${digestA} extra`],
    ['wrong verb', `rollback v1 ${shaA} ${digestA}`],
    ['wrong protocol', `deploy v2 ${shaA} ${digestA}`],
    ['uppercase SHA', `deploy v1 ${shaA.toUpperCase()} ${digestA}`],
    ['short SHA', `deploy v1 ${shaA.slice(0, 39)} ${digestA}`],
    ['tag reference', `deploy v1 ${shaA} ghcr.io/plutoless/minori:latest`],
    ['wrong repository', `deploy v1 ${shaA} ghcr.io/other/minori@sha256:${'1'.repeat(64)}`],
    ['short digest', `deploy v1 ${shaA} ghcr.io/plutoless/minori@sha256:${'1'.repeat(63)}`],
    ['uppercase digest', `deploy v1 ${shaA} ghcr.io/plutoless/minori@sha256:${'A'.repeat(64)}`],
    ['metacharacter', `deploy v1 ${shaA} ${digestA};id`],
    ['tab injection', `deploy\tv1 ${shaA} ${digestA}`],
    ['double-space injection', `deploy  v1 ${shaA} ${digestA}`],
    ['newline injection', `deploy v1 ${shaA} ${digestA}\nid`],
  ])('rejects %s before the release engine can run', async (_name, command) => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(`#!/usr/bin/env bash\nprintf called >> "$FAKE_RUNTIME_LOG/release.log"\n`);

    const result = await run(runtime, command);

    expect(result).toEqual(expect.objectContaining({ code: 2, stdout: 'minori_deploy result=rejected\n', stderr: '' }));
    expect(await runtime.logText('release.log')).toBe('');
    expect(await runtime.logText('docker.log')).toBe('');
  });

  it('rejects direct positional arguments before parsing the forced command', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine();

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`, ['deploy']);

    expect(result.code).toBe(2);
    expect(await runtime.logText('docker.log')).toBe('');
  });

  it.each([
    ['uppercase SHA', `deploy v1 ${shaA.toUpperCase()} ${digestA}`],
    ['uppercase digest', `deploy v1 ${shaA} ghcr.io/plutoless/minori@sha256:${'A'.repeat(64)}`],
  ])('rejects %s under a hostile inherited locale before invoking the engine', async (_name, command) => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(`#!/usr/bin/env bash\nprintf called >> "$FAKE_RUNTIME_LOG/release.log"\n`);

    const result = await run(runtime, command, [], { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });

    expect(result).toEqual(expect.objectContaining({ code: 2, stdout: 'minori_deploy result=rejected\n', stderr: '' }));
    expect(await runtime.logText('release.log')).toBe('');
  });

  it('rejects lock contention without invoking the release engine', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(`#!/usr/bin/env bash\nprintf called >> "$FAKE_RUNTIME_LOG/release.log"\n`);

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`, [], { FAKE_LOCKED: '1' });

    expect(result).toEqual(expect.objectContaining({ code: 75, stdout: 'minori_deploy result=locked\n', stderr: '' }));
    expect(await runtime.logText('release.log')).toBe('');
    expect(await runtime.logText('docker.log')).toBe('');
  });

  it.each([
    ['rollback_failed', 'rollback_failed'],
    ['recovery_failed', 'recovery_failed'],
  ])('propagates only the stable %s engine category', async (engineCategory, deployCategory) => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      `#!/usr/bin/env bash\nprintf 'minori_release result=%s\\n' '${engineCategory}'\nexit 1\n`,
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: `minori_deploy result=${deployCategory}\n`,
      stderr: '',
    }));
  });

  it('propagates failed_before_replace only with the strict active artifact', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      `#!/usr/bin/env bash\nprintf 'minori_release result=failed_before_replace active_sha=${shaA} active_image=${digestA}\\n'\nexit 1\n`,
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: `minori_deploy result=failed_before_replace active_sha=${shaA} active_image=${digestA}\n`,
      stderr: '',
    }));
  });

  it.each([0, 2, 75, 255])('does not trust rollback output with exit status %s', async (status) => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      `#!/usr/bin/env bash\nprintf 'minori_release result=rolled_back active_sha=${shaA} active_image=${digestA}\\n'\nexit ${status}\n`,
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_deploy result=failed\n', stderr: '' }));
  });

  it('propagates a rolled-back result only with the resulting active healthy artifact', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      `#!/usr/bin/env bash
printf 'minori_release result=rolled_back active_sha=${shaA} active_image=${digestA}\\n'
exit 1
`,
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: `minori_deploy result=rolled_back active_sha=${shaA} active_image=${digestA}\n`,
      stderr: '',
    }));
  });

  it('does not expose unrecognized engine output or stderr', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      '#!/usr/bin/env bash\nprintf \'secret-output\\n\'\nprintf \'secret-error\\n\' >&2\nexit 1\n',
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: 'minori_deploy result=failed\n',
      stderr: '',
    }));
  });

  it.each([
    ['success without active artifact', 'minori_release result=success'],
    ['success for a different artifact', `minori_release result=success active_sha=${shaA} active_image=ghcr.io/plutoless/minori@sha256:${'9'.repeat(64)}`],
    ['rollback with extra output', `minori_release result=rolled_back active_sha=${shaA} active_image=${digestA}\\nextra`],
  ])('fails closed on %s', async (_name, engineOutput) => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      `#!/usr/bin/env bash\nprintf '%b\\n' '${engineOutput}'\nexit 1\n`,
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_deploy result=failed\n', stderr: '' }));
  });
});

async function installerFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'minori-installer-test-')));
  const key = join(root, 'deployment-key');
  await writeFile(join(root, '.minori-ci-installer-test'), 'minori-ci-installer-test-v1\n', { mode: 0o600 });
  await execFileAsync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  return { root, publicKey: `${key}.pub`, authorizedKeys: join(root, 'root', '.ssh', 'authorized_keys') };
}

async function runInstaller(root: string, publicKey: string, extraEnv: NodeJS.ProcessEnv = {}) {
  try {
    const result = await execFileAsync(installer, [publicKey], {
      env: {
        ...process.env,
        MINORI_INSTALL_TEST_MODE: '1',
        MINORI_INSTALL_TEST_ROOT: root,
        ...extraEnv,
      },
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code: number | string; stdout?: string; stderr?: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

const unrelatedAuthorizedKeys = [
  '# operator access remains byte-for-byte',
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBOGUS operator@example',
  '',
].join('\n');

async function installedUpgradeFixture() {
  const fixture = await installerFixture();
  await mkdir(dirname(fixture.authorizedKeys), { recursive: true, mode: 0o700 });
  await writeFile(fixture.authorizedKeys, unrelatedAuthorizedKeys, { mode: 0o600 });
  await expect(runInstaller(fixture.root, fixture.publicKey)).resolves.toEqual(
    expect.objectContaining({ code: 0 }),
  );
  const before = await readFile(fixture.authorizedKeys, 'utf8');
  const deploymentEntry = before.split('\n').find((line) => line.startsWith('restrict,command='));
  expect(deploymentEntry).toBeDefined();
  return { ...fixture, deploymentEntry: deploymentEntry! };
}

async function expectUpgradeKeyRevoked(
  fixture: Awaited<ReturnType<typeof installedUpgradeFixture>>,
) {
  const after = await readFile(fixture.authorizedKeys, 'utf8');
  expect(after).toBe(unrelatedAuthorizedKeys);
  expect(after).not.toContain(fixture.deploymentEntry);
}

describe('isolated forced-command installer', { timeout: 15_000 }, () => {
  it('runs the exact installed forced command without accepting Bash startup hooks', async () => {
    const fixture = await installerFixture();
    await expect(runInstaller(fixture.root, fixture.publicKey)).resolves.toEqual(expect.objectContaining({ code: 0 }));
    const marker = join(fixture.root, 'outer-shell-hook-ran');
    const bashEnv = join(fixture.root, 'hostile-bash-env');
    await writeFile(bashEnv, `printf compromised > '${marker}'\n`);

    const policy = await readFile(
      join(fixture.root, 'etc', 'ssh', 'sshd_config.d', '00-minori-ci-deploy.conf'),
      'utf8',
    );
    expect(policy).toBe([
      '# Managed by Minori. Keep hostile startup variables out of root SSH sessions.',
      'Match User root',
      '    AcceptEnv LANG LC_*',
      '    SetEnv BASH_ENV=/dev/null ENV=/dev/null',
      'Match all',
      '',
    ].join('\n'));

    const authorized = await readFile(fixture.authorizedKeys, 'utf8');
    const forcedCommand = authorized.match(/command="([^"]+)"/)?.[1];
    expect(forcedCommand).toBe(join(fixture.root, 'opt', 'minori', 'bin', 'ci-deploy'));

    const hostileClientEnvironment = {
      BASH_ENV: bashEnv,
      'BASH_FUNC_ci-deploy%%': `() { printf compromised > '${marker}'; }`,
    };
    const acceptedEnvironment = Object.fromEntries(
      Object.entries(hostileClientEnvironment).filter(([name]) => name === 'LANG' || name.startsWith('LC_')),
    );
    expect(acceptedEnvironment).toEqual({});

    const result = await execFileAsync('/bin/bash', ['-c', forcedCommand!], {
      env: {
        HOME: fixture.root,
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        BASH_ENV: '/dev/null',
        ENV: '/dev/null',
        SSH_ORIGINAL_COMMAND: 'invalid',
        ...acceptedEnvironment,
      },
    }).catch((error: { code: number; stdout: string; stderr: string }) => error);

    expect(result).toEqual(expect.objectContaining({
      code: 2,
      stdout: 'minori_deploy result=rejected\n',
      stderr: '',
    }));
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('installs exact forced-command leaves and preserves unrelated authorized keys lines', async () => {
    const fixture = await installerFixture();
    await mkdir(dirname(fixture.authorizedKeys), { recursive: true, mode: 0o700 });
    await writeFile(fixture.authorizedKeys, 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBOGUS unrelated@example\n', { mode: 0o600 });

    const result = await runInstaller(fixture.root, fixture.publicKey);
    const repeated = await runInstaller(fixture.root, fixture.publicKey);

    expect(result).toEqual(expect.objectContaining({ code: 0, stdout: 'minori_ci_install result=success\n', stderr: '' }));
    expect(repeated).toEqual(expect.objectContaining({ code: 0, stdout: 'minori_ci_install result=success\n', stderr: '' }));
    const authorized = await readFile(fixture.authorizedKeys, 'utf8');
    expect(authorized).toContain('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBOGUS unrelated@example\n');
    const installedCommand = join(fixture.root, 'opt', 'minori', 'bin', 'ci-deploy');
    expect(authorized).toContain(`restrict,command="${installedCommand}" ssh-ed25519 `);
    expect(authorized.match(new RegExp(`restrict,command="${installedCommand}"`, 'g'))).toHaveLength(1);
    await expect(readFile(join(fixture.root, 'opt', 'minori', 'bin', 'ci-deploy'), 'utf8')).resolves.toContain('os.execve');
    await expect(readFile(join(fixture.root, 'opt', 'minori', 'libexec', 'ci-deploy'), 'utf8')).resolves.toContain('SSH_ORIGINAL_COMMAND');
    await expect(readFile(join(fixture.root, 'opt', 'minori', 'releases', 'rehearsal-v0.1.1.accepted'), 'utf8')).resolves.toBe(
      await readFile('deploy/vultr/rehearsal-v0.1.1.accepted', 'utf8'),
    );
  });

  it.each([
    ['missing sshd', 'sshd-missing', 'unsafe_sshd_environment'],
    ['failing initial sshd effective-policy query', 'sshd-effective-before', 'unsafe_sshd_environment'],
    ['unsafe PermitUserEnvironment', 'permit-user-environment', 'unsafe_sshd_environment'],
    ['sshd syntax validation', 'sshd-test', 'unsafe_sshd_environment'],
    ['effective-policy validation', 'effective-policy', 'unsafe_sshd_environment'],
    ['sshd reload', 'reload', 'sshd_reload_failed'],
    ['entrypoint installation', 'entrypoint-install', 'unsafe_installation'],
  ])(
    'keeps a preexisting deployment key revoked when %s fails during an upgrade',
    async (_boundary, failure, category) => {
      const fixture = await installedUpgradeFixture();

      const result = await runInstaller(fixture.root, fixture.publicKey, {
        MINORI_INSTALL_TEST_FAILURE: failure,
      });

      expect(result).toEqual(expect.objectContaining({
        code: 1,
        stderr: `minori_ci_install result=${category}\n`,
      }));
      await expectUpgradeKeyRevoked(fixture);
    },
  );

  it.each([
    [
      'an earlier hostile first-active value followed by the desired value',
      [
        'permituserenvironment no',
        'acceptenv LANG LC_*',
        'setenv BASH_ENV=/tmp/hostile ENV=/dev/null BASH_ENV=/dev/null',
      ].join('\n'),
    ],
    [
      'a duplicate desired value',
      [
        'permituserenvironment no',
        'acceptenv LANG LC_*',
        'setenv BASH_ENV=/dev/null ENV=/dev/null ENV=/dev/null',
      ].join('\n'),
    ],
  ])('rejects effective SetEnv containing %s', async (_case, effectivePolicy) => {
    const fixture = await installedUpgradeFixture();

    const result = await runInstaller(fixture.root, fixture.publicKey, {
      MINORI_INSTALL_TEST_EFFECTIVE_POLICY: effectivePolicy,
    });

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stderr: 'minori_ci_install result=unsafe_sshd_environment\n',
    }));
    await expectUpgradeKeyRevoked(fixture);
  });

  it('rejects a server-injected Bash function that the real login shell would import', async () => {
    const fixture = await installedUpgradeFixture();
    const marker = join(fixture.root, 'server-function-ran');

    await execFileAsync('/bin/bash', ['-c', 'hostile_server_function'], {
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'BASH_FUNC_hostile_server_function%%': `() { printf compromised > '${marker}'; }`,
      },
    });

    await expect(readFile(marker, 'utf8')).resolves.toBe('compromised');
    await rm(marker);
    const result = await runInstaller(fixture.root, fixture.publicKey, {
      MINORI_INSTALL_TEST_EFFECTIVE_POLICY: [
        'permituserenvironment no',
        'acceptenv LANG LC_*',
        'setenv BASH_ENV=/dev/null ENV=/dev/null BASH_FUNC_hostile_server_function%%=malicious',
      ].join('\n'),
    });

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stderr: 'minori_ci_install result=unsafe_sshd_environment\n',
    }));
    await expectUpgradeKeyRevoked(fixture);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['intermediate opt', (root: string) => join(root, 'opt')],
    ['intermediate root', (root: string) => join(root, 'root')],
    ['sshd policy directory', (root: string) => join(root, 'etc', 'ssh', 'sshd_config.d')],
    ['sshd policy', (root: string) => join(root, 'etc', 'ssh', 'sshd_config.d', '00-minori-ci-deploy.conf')],
    ['install root', (root: string) => join(root, 'opt', 'minori')],
    ['bin directory', (root: string) => join(root, 'opt', 'minori', 'bin')],
    ['installed leaf', (root: string) => join(root, 'opt', 'minori', 'bin', 'ci-deploy')],
  ])(
    'revokes the deployment key before rejecting an unsafe %s during upgrade',
    async (_targetKind, targetPath) => {
      const fixture = await installedUpgradeFixture();
      await chmod(targetPath(fixture.root), 0o777);

      const result = await runInstaller(fixture.root, fixture.publicKey);

      expect(result).toEqual(expect.objectContaining({
        code: 1,
        stderr: 'minori_ci_install result=unsafe_installation\n',
      }));
      await expectUpgradeKeyRevoked(fixture);
    },
  );

  it('clears hostile Bash startup hooks before every installed entrypoint reaches Bash', async () => {
    const fixture = await installerFixture();
    await runInstaller(fixture.root, fixture.publicKey);
    const marker = join(fixture.root, 'bash-env-ran');
    const bashEnv = join(fixture.root, 'hostile-bash-env');
    await writeFile(bashEnv, `printf compromised > '${marker}'\n`);
    for (const [name, stdout] of [
      ['ci-deploy', 'minori_deploy result=rejected\n'],
      ['minori-release', 'minori_release result=rejected\n'],
      ['rehearse-release', 'minori_rehearsal result=rejected\n'],
    ]) {
      const installed = join(fixture.root, 'opt', 'minori', 'bin', name);
      const result = await execFileAsync(installed, [], {
        env: {
          ...process.env,
          SSH_ORIGINAL_COMMAND: 'invalid',
          BASH_ENV: bashEnv,
          'BASH_FUNC_emit_and_exit%%': `() { printf compromised > '${marker}'; }`,
        },
      }).catch((error: { code: number; stdout: string; stderr: string }) => error);

      expect(result).toEqual(expect.objectContaining({ code: 2, stdout, stderr: '' }));
    }
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['intermediate opt', 'intermediate root', 'sshd policy directory', 'sshd policy', 'install root', 'bin directory', 'installed leaf'])(
    'rejects a symlinked %s before authorized_keys or a target is changed',
    async (targetKind) => {
      const fixture = await installerFixture();
      const target = join(fixture.root, 'symlink-target');
      await mkdir(target, { recursive: true });
      const installRoot = join(fixture.root, 'opt', 'minori');
      const bin = join(installRoot, 'bin');
      const leaf = join(bin, 'ci-deploy');
      const policyDirectory = join(fixture.root, 'etc', 'ssh', 'sshd_config.d');
      const policy = join(policyDirectory, '00-minori-ci-deploy.conf');
      const targetPath = targetKind === 'intermediate opt'
        ? join(fixture.root, 'opt')
        : targetKind === 'intermediate root'
          ? join(fixture.root, 'root')
          : targetKind === 'sshd policy directory'
            ? policyDirectory
            : targetKind === 'sshd policy'
              ? policy
          : targetKind === 'install root'
            ? installRoot
            : targetKind === 'bin directory'
              ? bin
              : leaf;
      await mkdir(dirname(targetPath), { recursive: true });
      await symlink(target, targetPath);

      const result = await runInstaller(fixture.root, fixture.publicKey);

      expect(result).toEqual(expect.objectContaining({ code: 1, stderr: 'minori_ci_install result=unsafe_installation\n' }));
      await expect(readFile(fixture.authorizedKeys, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(target, 'sentinel'), 'utf8').catch(() => 'absent')).toBe('absent');
    },
  );

  it('refuses an unexpected existing SSH environment policy before changing installed leaves', async () => {
    const fixture = await installedUpgradeFixture();
    const installed = join(fixture.root, 'opt', 'minori', 'bin', 'ci-deploy');
    const original = await readFile(installed, 'utf8');
    const policy = join(fixture.root, 'etc', 'ssh', 'sshd_config.d', '00-minori-ci-deploy.conf');
    await writeFile(policy, 'Match User root\n    AcceptEnv *\n');
    await writeFile(installed, `${original}\n# preserved sentinel\n`);

    const result = await runInstaller(fixture.root, fixture.publicKey);

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stderr: 'minori_ci_install result=unsafe_sshd_environment\n',
    }));
    await expect(readFile(installed, 'utf8')).resolves.toBe(`${original}\n# preserved sentinel\n`);
    await expectUpgradeKeyRevoked(fixture);
  });

  it.each(['/', '/opt/minori', '/root'])(
    'rejects broad or production test root %s before installation',
    async (unsafeRoot) => {
      const fixture = await installerFixture();

      const result = await runInstaller(unsafeRoot, fixture.publicKey);

      expect(result).toEqual(expect.objectContaining({ code: 1, stderr: 'minori_ci_install result=unsafe_test_root\n' }));
    },
  );

  it('requires the exact fixture sentinel before any installation', async () => {
    const fixture = await installerFixture();
    await rm(join(fixture.root, '.minori-ci-installer-test'));

    const result = await runInstaller(fixture.root, fixture.publicKey);

    expect(result).toEqual(expect.objectContaining({ code: 1, stderr: 'minori_ci_install result=unsafe_test_root\n' }));
    await expect(readFile(fixture.authorizedKeys, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
