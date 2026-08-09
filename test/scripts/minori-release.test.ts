import { execFile } from 'node:child_process';
import { chmod, lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  createFakeDeployRuntime,
  digestA,
  digestB,
  digestC,
  digestD,
  shaA,
  shaB,
  shaC,
  shaD,
} from './fake-deploy-runtime.js';

const execFileAsync = promisify(execFile);
const releaseEngine = 'deploy/vultr/minori-release';
const rehearsal = 'deploy/vultr/rehearse-release.sh';

type Runtime = Awaited<ReturnType<typeof createFakeDeployRuntime>>;

async function run(runtime: Runtime, extraEnv: NodeJS.ProcessEnv = {}, args = ['v1', shaA, digestA]) {
  const effectiveEnv = { ...extraEnv };
  if (Object.prototype.hasOwnProperty.call(effectiveEnv, 'FAKE_CURRENT_IMAGE')) {
    await runtime.setCurrentImage(effectiveEnv.FAKE_CURRENT_IMAGE ?? '');
    delete effectiveEnv.FAKE_CURRENT_IMAGE;
  }
  try {
    const result = await execFileAsync(releaseEngine, args, {
      env: { ...runtime.env, ...effectiveEnv },
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code: number | string; stdout?: string; stderr?: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function runRehearsal(
  runtime: Runtime,
  extraEnv: NodeJS.ProcessEnv = {},
  args = [shaA, digestA],
) {
  const effectiveEnv = { ...extraEnv };
  if (Object.prototype.hasOwnProperty.call(effectiveEnv, 'FAKE_CURRENT_IMAGE')) {
    await runtime.setCurrentImage(effectiveEnv.FAKE_CURRENT_IMAGE ?? '');
    delete effectiveEnv.FAKE_CURRENT_IMAGE;
  }
  try {
    const result = await execFileAsync(rehearsal, args, {
      env: { ...runtime.env, ...effectiveEnv },
    });
    return { code: 0, ...result };
  } catch (error) {
    const failure = error as { code: number | string; stdout?: string; stderr?: string };
    return { code: failure.code, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

async function records(runtime: Runtime) {
  const directory = join(runtime.root, 'releases', 'records');
  const names = await readdir(directory);
  return Promise.all(names.sort().map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}

async function rehearsalRecords(runtime: Runtime) {
  const directory = join(runtime.root, 'releases', 'rehearsal-records');
  const names = await readdir(directory);
  return Promise.all(names.sort().map(async (name) => JSON.parse(await readFile(join(directory, name), 'utf8'))));
}

async function pendingExists(runtime: Runtime) {
  try {
    await lstat(join(runtime.root, 'releases', 'pending.tsv'));
    return true;
  } catch {
    return false;
  }
}

async function seedDigestState(
  runtime: Runtime,
  rows: Array<[string, string]> = [[shaB, digestB]],
) {
  const completeRows: Array<[string, string, string, string]> = [];
  for (const [sha, digest] of rows) {
    const contract = await runtime.writeDigestContract(digest);
    completeRows.push(['v1', sha, digest, contract]);
  }
  await runtime.writeState(completeRows);
  return completeRows;
}

describe('transactional digest release engine', { timeout: 15_000 }, () => {
  it.each([
    ['pull failure', { FAKE_FAIL: 'pull' }],
    ['image protocol mismatch', { FAKE_PROTOCOL: 'v2' }],
    ['OCI revision mismatch', { FAKE_REVISION: shaB }],
    ['architecture mismatch', { FAKE_ARCHITECTURE: 'arm64' }],
    ['UID/GID mismatch', { FAKE_USER: '10001' }],
    ['repository digest mismatch', { FAKE_REPO_DIGEST: digestB }],
    ['Compose image mismatch', { FAKE_COMPOSE_IMAGE: digestB }],
  ])('fails before migration or replacement on %s', async (_name, scenario) => {
    const runtime = await createFakeDeployRuntime();

    const result = await run(runtime, scenario);

    expect(result).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_release result=failed_before_replace\n', stderr: '' }));
    const docker = await runtime.logText('docker.log');
    expect(docker).not.toContain('db:migrate');
    expect(docker).not.toContain('up -d --no-build');
    expect(await records(runtime)).toEqual([
      expect.objectContaining({ result: 'failed_before_replace', rollbackTargetCategory: 'none' }),
    ]);
  });

  it('runs sanitized runtime preflight before migration and stops before replacement when it fails', async () => {
    const runtime = await createFakeDeployRuntime();

    const result = await run(runtime, { FAKE_FAIL: 'preflight', DATABASE_URL: 'postgres://must-not-leak' });

    const docker = await runtime.logText('docker.log');
    expect(docker).toContain('runtime:verify');
    expect(docker).not.toContain('db:migrate');
    expect(docker).not.toContain('up -d --no-build');
    expect(`${result.stdout}${result.stderr}${JSON.stringify(await records(runtime))}`).not.toContain('must-not-leak');
  });

  it('stops before service replacement when migration fails', async () => {
    const runtime = await createFakeDeployRuntime();

    const result = await run(runtime, { FAKE_FAIL: 'migration' });

    expect(result.code).toBe(1);
    const docker = await runtime.logText('docker.log');
    expect(docker.indexOf('runtime:verify')).toBeLessThan(docker.indexOf('db:migrate'));
    expect(docker).not.toContain('up -d --no-build');
    expect((await records(runtime))[0]).toEqual(expect.objectContaining({ result: 'failed_before_replace' }));
  });

  it('deploys an exact digest, verifies readiness, installs its contract, and atomically records state', async () => {
    const runtime = await createFakeDeployRuntime();

    const result = await run(runtime);

    expect(result).toEqual(expect.objectContaining({ code: 0, stdout: 'minori_release result=success\n', stderr: '' }));
    const docker = await runtime.logText('docker.log');
    expect(docker).toContain(`image= :: pull ${digestA}`);
    expect(docker).toContain(`image=${digestA} :: compose --project-name minori`);
    expect(docker).toContain('up -d --no-build');
    expect(await runtime.logText('curl.log')).toContain('/health/ready');

    const contract = join(runtime.root, 'releases', 'contracts', `${'1'.repeat(64)}.compose.yaml`);
    expect(await readFile(contract, 'utf8')).toContain('MINORI_IMAGE');
    expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(
      `v1\t${shaA}\t${digestA}\t${contract}\n`
      + `v1\t${shaB}\tminori:${shaB}\t${join(runtime.root, 'releases', `${shaB}.compose.yaml`)}\n`,
    );
    expect((await stat(join(runtime.root, 'releases', 'state.tsv'))).mode & 0o777).toBe(0o600);
    expect(await readdir(join(runtime.root, 'releases'))).not.toEqual(expect.arrayContaining(['state.tsv.tmp']));
  });

  it('captures the legacy local release only as the first digest release predecessor', async () => {
    const runtime = await createFakeDeployRuntime();
    const legacyImage = `minori:${shaB}`;
    const legacyContract = await runtime.writeContract(shaB);

    const result = await run(runtime, { FAKE_CURRENT_IMAGE: legacyImage });

    expect(result.code).toBe(0);
    expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(
      `v1\t${shaA}\t${digestA}\t${join(runtime.root, 'releases', 'contracts', `${'1'.repeat(64)}.compose.yaml`)}\n`
      + `v1\t${shaB}\t${legacyImage}\t${legacyContract}\n`,
    );
  });

  it('requires an existing release with a captured rollback contract', async () => {
    const runtime = await createFakeDeployRuntime();

    const result = await run(runtime, { FAKE_CURRENT_IMAGE: '' });

    expect(result.code).toBe(1);
    const docker = await runtime.logText('docker.log');
    expect(docker).not.toContain('pull');
    expect(docker).not.toContain('db:migrate');
    expect(docker).not.toContain('up -d --no-build');
  });

  it('restores and verifies the saved digest when candidate readiness fails', async () => {
    const runtime = await createFakeDeployRuntime();
    const priorRows = await seedDigestState(runtime);
    const originalState = `${priorRows[0].join('\t')}\n`;

    const result = await run(runtime, {
      FAKE_CURRENT_IMAGE: digestB,
      FAKE_READY_SEQUENCE: '0,1',
    });

    expect(result).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_release result=rolled_back\n', stderr: '' }));
    const docker = await runtime.logText('docker.log');
    expect(docker).toContain(`image=${digestA} :: compose --project-name minori`);
    expect(docker).toContain(`image=${digestB} :: compose --project-name minori`);
    expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(originalState);
    expect((await records(runtime))[0]).toEqual(expect.objectContaining({
      result: 'rolled_back',
      rollbackTargetCategory: 'saved_digest',
    }));
  });

  it('reports rollback failure as a terminal stable category', async () => {
    const runtime = await createFakeDeployRuntime();
    await seedDigestState(runtime);

    const result = await run(runtime, {
      FAKE_CURRENT_IMAGE: digestB,
      FAKE_READY_SEQUENCE: '0,0',
    });

    expect(result).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_release result=rollback_failed\n', stderr: '' }));
    expect((await records(runtime))[0]).toEqual(expect.objectContaining({
      result: 'rollback_failed',
      rollbackTargetCategory: 'saved_digest',
    }));
  });

  it('retains exactly the current release and two verified predecessors without pruning referenced images', async () => {
    const runtime = await createFakeDeployRuntime();
    const rows = await seedDigestState(runtime, [
      [shaB, digestB],
      [shaC, digestC],
      [shaD, digestD],
    ]);

    const result = await run(runtime, { FAKE_CURRENT_IMAGE: digestB });

    expect(result.code).toBe(0);
    const state = await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8');
    expect(state).toBe(
      `v1\t${shaA}\t${digestA}\t${join(runtime.root, 'releases', 'contracts', `${'1'.repeat(64)}.compose.yaml`)}\n`
      + `${rows[0].join('\t')}\n${rows[1].join('\t')}\n`,
    );
    const docker = await runtime.logText('docker.log');
    expect(docker).toContain(`image rm ${digestD}`);
    expect(docker).not.toContain(`image rm ${digestA}`);
    expect(docker).not.toContain(`image rm ${digestB}`);
    expect(docker).not.toContain(`image rm ${digestC}`);
  });

  it('writes release records with only the approved stable metadata keys', async () => {
    const runtime = await createFakeDeployRuntime();

    await run(runtime);

    const [record] = await records(runtime);
    expect(Object.keys(record).sort()).toEqual([
      'commitSha',
      'image',
      'operatorCategory',
      'protocol',
      'result',
      'rollbackTargetCategory',
      'timestamp',
    ]);
    expect(record).toEqual({
      protocol: 'v1',
      commitSha: shaA,
      image: digestA,
      timestamp: '2026-08-09T12:34:56Z',
      operatorCategory: 'github_actions',
      result: 'success',
      rollbackTargetCategory: 'none',
    });
  });

  it('restores the prior service and state if the success record cannot be written', async () => {
    const runtime = await createFakeDeployRuntime();
    const priorRows = await seedDigestState(runtime);
    const originalState = `${priorRows[0].join('\t')}\n`;

    const result = await run(runtime, {
      FAKE_CURRENT_IMAGE: digestB,
      FAKE_DATE_FAIL: '1',
    });

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: 'minori_release result=rolled_back\n',
    }));
    const docker = await runtime.logText('docker.log');
    expect(docker.lastIndexOf(`image=${digestB} :: compose --project-name minori`)).toBeGreaterThan(
      docker.indexOf(`image=${digestA} :: compose --project-name minori`),
    );
    expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(originalState);
  });

  it('validates every saved row before pulling or consuming rollback state', async () => {
    const runtime = await createFakeDeployRuntime();
    await runtime.writeState([['v1', shaB, 'minori:latest', '/tmp/attacker.compose.yaml']]);

    const result = await run(runtime, { FAKE_CURRENT_IMAGE: 'minori:latest' });

    expect(result.code).toBe(1);
    expect(await runtime.logText('docker.log')).not.toContain('pull');
    expect((await records(runtime))[0]).toEqual(expect.objectContaining({ result: 'failed_before_replace' }));
  });

  it('rejects a saved digest whose OCI revision does not equal its saved SHA', async () => {
    const runtime = await createFakeDeployRuntime();
    const contract = await runtime.writeDigestContract(digestB);
    await runtime.writeState([['v1', shaC, digestB, contract]]);

    const result = await run(runtime, { FAKE_CURRENT_IMAGE: digestB });

    expect(result.code).toBe(1);
    const docker = await runtime.logText('docker.log');
    expect(docker).not.toContain('pull');
    expect(docker).not.toContain('db:migrate');
    expect(docker).not.toContain('up -d --no-build');
  });

  it('rejects a non-root-only state file before Docker is touched', async () => {
    const runtime = await createFakeDeployRuntime();
    const rows = await seedDigestState(runtime);
    const statePath = await runtime.writeState(rows);
    await chmod(statePath, 0o640);

    const result = await run(runtime, { FAKE_CURRENT_IMAGE: digestB });

    expect(result.code).toBe(1);
    expect(await runtime.logText('docker.log')).toBe('');
  });

  it.each([0o200, 0o400, 0o640, 0o700])(
    'rejects a production env file with mode %s before Docker is touched',
    async (mode) => {
      const runtime = await createFakeDeployRuntime();
      await chmod(join(runtime.root, 'minori.env'), mode);

      const result = await run(runtime);

      expect(result.code).toBe(1);
      expect(await runtime.logText('docker.log')).toBe('');
    },
  );

  it('validates the captured current Compose contract before pulling the candidate', async () => {
    const runtime = await createFakeDeployRuntime();
    await seedDigestState(runtime);

    const result = await run(runtime, {
      FAKE_CURRENT_IMAGE: digestB,
      FAKE_SAVED_COMPOSE_IMAGE: digestA,
    });

    expect(result.code).toBe(1);
    const docker = await runtime.logText('docker.log');
    expect(docker).toContain(`image=${digestB} :: compose --project-name minori`);
    expect(docker).not.toContain('pull');
    expect(docker).not.toContain('db:migrate');
  });

  it('rejects malformed direct arguments without touching Docker or release records', async () => {
    const runtime = await createFakeDeployRuntime();

    const result = await run(runtime, {}, ['v1', shaA.toUpperCase(), digestA]);

    expect(result.code).toBe(2);
    expect(await runtime.logText('docker.log')).toBe('');
    expect(await records(runtime)).toEqual([]);
  });

  it.each(['after_journal', 'after_candidate_switch', 'after_candidate_ready', 'after_state_write'])(
    'restores exact service and durable state on an interrupt at %s',
    async (point) => {
      const runtime = await createFakeDeployRuntime();
      const priorRows = await seedDigestState(runtime);
      await runtime.setCurrentImage(digestB);
      const originalState = `${priorRows[0].join('\t')}\n`;

      const result = await run(runtime, { MINORI_TEST_INTERRUPT_AT: point });

      expect(result.stdout).toBe('minori_release result=rolled_back\n');
      expect(await runtime.currentImage()).toBe(digestB);
      expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(originalState);
      expect(await pendingExists(runtime)).toBe(false);
    },
  );

  it.each(['after_journal', 'after_candidate_switch', 'after_state_write'])(
    'reconciles a crash journal before admitting a restart at %s',
    async (point) => {
      const runtime = await createFakeDeployRuntime();
      await seedDigestState(runtime);
      await runtime.setCurrentImage(digestB);

      await run(runtime, { MINORI_TEST_CRASH_AT: point });
      expect(await pendingExists(runtime)).toBe(true);

      const restarted = await run(runtime);

      expect(restarted).toEqual(expect.objectContaining({ code: 0, stdout: 'minori_release result=success\n' }));
      expect(await runtime.currentImage()).toBe(digestA);
      expect((await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).split('\n')[0]).toContain(`\t${digestA}\t`);
      expect(await pendingExists(runtime)).toBe(false);
      const docker = await runtime.logText('docker.log');
      if (point === 'after_candidate_switch') {
        expect(docker.lastIndexOf(`image=${digestB} :: compose --project-name minori`)).toBeGreaterThan(
          docker.indexOf(`image=${digestA} :: compose --project-name minori`),
        );
      }
    },
    15_000,
  );

  it.each(['mismatched original metadata', 'leading header tab', 'trailing header tab', 'mode 0400', 'mode 0640'])(
    'rejects a pending journal with %s before a new pull or switch',
    async (scenario) => {
      const runtime = await createFakeDeployRuntime();
      await seedDigestState(runtime);
      await runtime.setCurrentImage(digestB);
      await run(runtime, { MINORI_TEST_CRASH_AT: 'after_journal' });
      const pending = join(runtime.root, 'releases', 'pending.tsv');
      if (scenario === 'mismatched original metadata') {
        const contents = await readFile(pending, 'utf8');
        await writeFile(pending, contents.replace(`original\tv1\t${shaB}`, `original\tv1\t${shaC}`), { mode: 0o600 });
      } else if (scenario === 'leading header tab' || scenario === 'trailing header tab') {
        const lines = (await readFile(pending, 'utf8')).split('\n');
        lines[0] = scenario === 'leading header tab' ? `\t${lines[0]}` : `${lines[0]}\t`;
        await writeFile(pending, lines.join('\n'), { mode: 0o600 });
      } else {
        await chmod(pending, scenario === 'mode 0400' ? 0o400 : 0o640);
      }
      const before = (await runtime.logText('docker.log')).length;

      const restarted = await run(runtime);

      expect(restarted).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_release result=recovery_failed\n' }));
      const newDocker = (await runtime.logText('docker.log')).slice(before);
      expect(newDocker).not.toContain('pull');
      expect(newDocker).not.toContain('up -d --no-build');
      expect(await pendingExists(runtime)).toBe(true);
    },
    15_000,
  );

  it.each(['replaced', 'healthy', 'state_written'])(
    'rolls back when durable journal phase %s cannot be written',
    async (phase) => {
      const runtime = await createFakeDeployRuntime();
      const rows = await seedDigestState(runtime);
      await runtime.setCurrentImage(digestB);

      const result = await run(runtime, { MINORI_TEST_FAIL_PENDING_PHASE: phase });

      expect(result).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_release result=rolled_back\n' }));
      expect(await runtime.currentImage()).toBe(digestB);
      expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(`${rows[0].join('\t')}\n`);
      expect(await pendingExists(runtime)).toBe(false);
    },
  );
});

describe('bounded saved-release rehearsal', { timeout: 15_000 }, () => {
  it('switches only to saved position 1 and restores the exact saved position 0 digest', async () => {
    const runtime = await createFakeDeployRuntime();
    const rows = await seedDigestState(runtime, [
      [shaA, digestA],
      [shaB, digestB],
      [shaC, digestC],
    ]);
    const originalState = `${rows.map((row) => row.join('\t')).join('\n')}\n`;

    const result = await runRehearsal(runtime, { FAKE_CURRENT_IMAGE: digestA });

    expect(result).toEqual(expect.objectContaining({
      code: 0,
      stdout: 'minori_rehearsal result=success\n',
      stderr: '',
    }));
    const docker = await runtime.logText('docker.log');
    const predecessorUp = docker.indexOf(`image=${digestB} :: compose --project-name minori`);
    const currentUp = docker.lastIndexOf(`image=${digestA} :: compose --project-name minori`);
    expect(predecessorUp).toBeGreaterThan(-1);
    expect(currentUp).toBeGreaterThan(predecessorUp);
    expect(docker).not.toContain('pull');
    expect(docker).not.toContain('runtime:verify');
    expect(docker).not.toContain('db:migrate');
    expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(originalState);
    expect(await records(runtime)).toEqual([]);
  });

  it('supports the saved legacy release only as position 1', async () => {
    const runtime = await createFakeDeployRuntime();
    const currentContract = await runtime.writeDigestContract(digestA);
    const legacyImage = `minori:${shaB}`;
    const legacyContract = await runtime.writeContract(shaB);
    await runtime.writeState([
      ['v1', shaA, digestA, currentContract],
      ['v1', shaB, legacyImage, legacyContract],
    ]);

    const result = await runRehearsal(runtime, { FAKE_CURRENT_IMAGE: digestA });

    expect(result.code).toBe(0);
    const docker = await runtime.logText('docker.log');
    expect(docker).toContain(`image=${legacyImage} :: compose --project-name minori`);
    expect(docker.lastIndexOf(`image=${digestA} :: compose --project-name minori`)).toBeGreaterThan(
      docker.indexOf(`image=${legacyImage} :: compose --project-name minori`),
    );
  });

  it.each([
    ['arbitrary current SHA and digest', [shaC, digestC]],
    ['saved predecessor passed as current', [shaB, digestB]],
    ['extra target argument', [shaA, digestA, digestB]],
  ])('rejects %s without replacing the service', async (_name, args) => {
    const runtime = await createFakeDeployRuntime();
    await seedDigestState(runtime, [
      [shaA, digestA],
      [shaB, digestB],
    ]);

    const result = await runRehearsal(runtime, { FAKE_CURRENT_IMAGE: digestA }, args);

    expect(result.code).toBe(2);
    expect(await runtime.logText('docker.log')).not.toContain('up -d --no-build');
  });

  it('rejects a rehearsal when no immediate predecessor is saved', async () => {
    const runtime = await createFakeDeployRuntime();
    await seedDigestState(runtime, [[shaA, digestA]]);

    const result = await runRehearsal(runtime, { FAKE_CURRENT_IMAGE: digestA });

    expect(result.code).toBe(2);
    expect(await runtime.logText('docker.log')).not.toContain('up -d --no-build');
  });

  it('rejects a saved predecessor whose OCI revision does not equal its saved SHA', async () => {
    const runtime = await createFakeDeployRuntime();
    const currentContract = await runtime.writeDigestContract(digestA);
    const predecessorContract = await runtime.writeDigestContract(digestB);
    await runtime.writeState([
      ['v1', shaA, digestA, currentContract],
      ['v1', shaC, digestB, predecessorContract],
    ]);

    const result = await runRehearsal(runtime, { FAKE_CURRENT_IMAGE: digestA });

    expect(result.code).toBe(2);
    expect(await runtime.logText('docker.log')).not.toContain('up -d --no-build');
  });

  it('restores position 0 if the predecessor does not become ready', async () => {
    const runtime = await createFakeDeployRuntime();
    await seedDigestState(runtime, [
      [shaA, digestA],
      [shaB, digestB],
    ]);

    const result = await runRehearsal(runtime, {
      FAKE_CURRENT_IMAGE: digestA,
      FAKE_READY_SEQUENCE: '0,1',
    });

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: 'minori_rehearsal result=predecessor_unhealthy_restored\n',
    }));
    const docker = await runtime.logText('docker.log');
    expect(docker.lastIndexOf(`image=${digestA} :: compose --project-name minori`)).toBeGreaterThan(
      docker.indexOf(`image=${digestB} :: compose --project-name minori`),
    );
  });

  it.each([0o200, 0o400, 0o640, 0o700])(
    'rejects env mode %s before a rehearsal switch',
    async (mode) => {
      const runtime = await createFakeDeployRuntime();
      await seedDigestState(runtime, [[shaA, digestA], [shaB, digestB]]);
      await runtime.setCurrentImage(digestA);
      await chmod(join(runtime.root, 'minori.env'), mode);

      const result = await runRehearsal(runtime);

      expect(result.code).toBe(2);
      expect(await runtime.logText('docker.log')).toBe('');
    },
  );

  it.each(['group writable Lark directory', 'symlinked Lark directory'])(
    'rejects a %s before a rehearsal switch',
    async (scenario) => {
      const runtime = await createFakeDeployRuntime();
      await seedDigestState(runtime, [[shaA, digestA], [shaB, digestB]]);
      await runtime.setCurrentImage(digestA);
      const lark = join(runtime.root, 'lark');
      if (scenario === 'group writable Lark directory') {
        await chmod(lark, 0o770);
      } else {
        const target = join(runtime.root, 'lark-target');
        await rm(lark, { recursive: true });
        await symlink(target, lark);
      }

      const result = await runRehearsal(runtime);

      expect(result.code).toBe(2);
      expect(await runtime.logText('docker.log')).toBe('');
    },
  );

  it.each(['after_rehearsal_journal', 'after_predecessor_switch', 'after_current_switch'])(
    'restores position 0 and clears the journal on an interrupt at %s',
    async (point) => {
      const runtime = await createFakeDeployRuntime();
      const rows = await seedDigestState(runtime, [[shaA, digestA], [shaB, digestB], [shaC, digestC]]);
      await runtime.setCurrentImage(digestA);
      const originalState = `${rows.map((row) => row.join('\t')).join('\n')}\n`;

      const result = await runRehearsal(runtime, { MINORI_TEST_INTERRUPT_AT: point });

      expect(result.stdout).toBe('minori_rehearsal result=interrupted_restored\n');
      expect(await runtime.currentImage()).toBe(digestA);
      expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(originalState);
      expect(await pendingExists(runtime)).toBe(false);
    },
  );

  it('recovers a crash after the predecessor switch before running a new rehearsal', async () => {
    const runtime = await createFakeDeployRuntime();
    await seedDigestState(runtime, [[shaA, digestA], [shaB, digestB]]);
    await runtime.setCurrentImage(digestA);

    await runRehearsal(runtime, { MINORI_TEST_CRASH_AT: 'after_predecessor_switch' });
    expect(await runtime.currentImage()).toBe(digestB);
    expect(await pendingExists(runtime)).toBe(true);

    const restarted = await runRehearsal(runtime);

    expect(restarted).toEqual(expect.objectContaining({ code: 0, stdout: 'minori_rehearsal result=success\n' }));
    expect(await runtime.currentImage()).toBe(digestA);
    expect(await pendingExists(runtime)).toBe(false);
  }, 15_000);

  it('falls back to the proven predecessor and durably promotes it when forward restore fails', async () => {
    const runtime = await createFakeDeployRuntime();
    const rows = await seedDigestState(runtime, [[shaA, digestA], [shaB, digestB], [shaC, digestC]]);
    await runtime.setCurrentImage(digestA);

    const result = await runRehearsal(runtime, { FAKE_READY_SEQUENCE: '1,0,1' });

    expect(result).toEqual(expect.objectContaining({
      code: 1,
      stdout: 'minori_rehearsal result=restore_failed_recovered_predecessor\n',
    }));
    expect(await runtime.currentImage()).toBe(digestB);
    expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(
      `${rows[1].join('\t')}\n${rows[0].join('\t')}\n${rows[2].join('\t')}\n`,
    );
    expect(await pendingExists(runtime)).toBe(false);
    expect(await rehearsalRecords(runtime)).toEqual([
      {
        protocol: 'v1',
        timestamp: '2026-08-09T12:34:56Z',
        result: 'restore_failed_recovered_predecessor',
        recoveredSha: shaB,
        recoveredImage: digestB,
      },
    ]);
  });

  it.each(['after_fallback_switch', 'after_fallback_state'])(
    'reconciles a crash at %s to the proven predecessor',
    async (point) => {
      const runtime = await createFakeDeployRuntime();
      const rows = await seedDigestState(runtime, [[shaA, digestA], [shaB, digestB], [shaC, digestC]]);
      await runtime.setCurrentImage(digestA);

      await runRehearsal(runtime, {
        FAKE_READY_SEQUENCE: '1,0,1',
        MINORI_TEST_CRASH_AT: point,
      });
      expect(await runtime.currentImage()).toBe(digestB);
      expect(await pendingExists(runtime)).toBe(true);

      const restarted = await runRehearsal(runtime, { FAKE_READY_SEQUENCE: '1' });

      expect(restarted).toEqual(expect.objectContaining({ code: 2, stdout: 'minori_rehearsal result=rejected\n' }));
      expect(await runtime.currentImage()).toBe(digestB);
      expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(
        `${rows[1].join('\t')}\n${rows[0].join('\t')}\n${rows[2].join('\t')}\n`,
      );
      expect(await pendingExists(runtime)).toBe(false);
      expect(await rehearsalRecords(runtime)).toHaveLength(1);
    },
  );

  it.each([
    ['predecessor_proven', '1'],
    ['restoring_current', '1'],
    ['fallback', '1,0,1'],
  ])('restores position 0 when rehearsal journal phase %s cannot be written', async (phase, readySequence) => {
    const runtime = await createFakeDeployRuntime();
    const rows = await seedDigestState(runtime, [[shaA, digestA], [shaB, digestB]]);
    await runtime.setCurrentImage(digestA);

    const result = await runRehearsal(runtime, {
      FAKE_READY_SEQUENCE: readySequence,
      MINORI_TEST_FAIL_PENDING_PHASE: phase,
    });

    expect(result).toEqual(expect.objectContaining({ code: 1, stdout: 'minori_rehearsal result=journal_failed_restored\n' }));
    expect(await runtime.currentImage()).toBe(digestA);
    expect(await readFile(join(runtime.root, 'releases', 'state.tsv'), 'utf8')).toBe(`${rows.map((row) => row.join('\t')).join('\n')}\n`);
    expect(await pendingExists(runtime)).toBe(false);
  });
});
