import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createFakeDeployRuntime,
  digestA,
  shaA,
} from './fake-deploy-runtime.js';

const execFileAsync = promisify(execFile);
const entrypoint = 'deploy/vultr/ci-deploy';

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

describe('restricted forced-command parser', () => {
  it('passes one completely validated Deployment Protocol v1 request to the release engine', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_RUNTIME_LOG/release.log"\nprintf \'minori_release result=success\\n\'\n',
    );

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`);

    expect(result).toEqual(expect.objectContaining({ code: 0, stdout: 'minori_deploy result=success\n', stderr: '' }));
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

  it('rejects lock contention without invoking the release engine', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.installFakeReleaseEngine(`#!/usr/bin/env bash\nprintf called >> "$FAKE_RUNTIME_LOG/release.log"\n`);

    const result = await run(runtime, `deploy v1 ${shaA} ${digestA}`, [], { FAKE_LOCKED: '1' });

    expect(result).toEqual(expect.objectContaining({ code: 75, stdout: 'minori_deploy result=locked\n', stderr: '' }));
    expect(await runtime.logText('release.log')).toBe('');
    expect(await runtime.logText('docker.log')).toBe('');
  });

  it.each([
    ['failed_before_replace', 'failed_before_replace'],
    ['rolled_back', 'rolled_back'],
    ['rollback_failed', 'rollback_failed'],
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
});
