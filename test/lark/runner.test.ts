import { EventEmitter } from 'node:events';
import type { spawn as nodeSpawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LarkCliError } from '../../src/lark/errors.js';
import { LarkRunner, type SpawnedProcess } from '../../src/lark/runner.js';

const AUTH_STATUS = {
  appId: 'cli_app_id',
  brand: 'feishu',
  defaultAs: 'user',
  identity: 'user',
  identities: {
    user: { status: 'ready', available: true },
    bot: { status: 'ready', available: true },
  },
};

type FakeProcess = SpawnedProcess & {
  emit(event: 'close', code: number | null): boolean;
  kill: ReturnType<typeof vi.fn>;
};

function fakeProcess(output?: { stdout?: string; stderr?: string; code?: number }): FakeProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    kill: vi.fn((_signal?: NodeJS.Signals) => {
      queueMicrotask(() => emitter.emit('close', null));
      return true;
    }),
  }) as FakeProcess;

  if (output) {
    queueMicrotask(() => {
      if (output.stdout) stdout.end(output.stdout);
      if (output.stderr) stderr.end(output.stderr);
      emitter.emit('close', output.code ?? 0);
    });
  }
  return child;
}

function runnerWith(child: FakeProcess, overrides: Partial<{
  timeoutMs: number;
  maxOutputBytes: number;
  onExecution: (metadata: unknown) => void;
}> = {}) {
  const spawn = vi.fn(() => child) as unknown as typeof nodeSpawn;
  const runner = new LarkRunner({
    binary: '/opt/minori/lark-cli',
    configDir: '/var/lib/minori/lark',
    timeoutMs: overrides.timeoutMs ?? 1_000,
    maxOutputBytes: overrides.maxOutputBytes ?? 10_000,
    spawn,
    ...(overrides.onExecution ? { onExecution: overrides.onExecution } : {}),
  });
  return { runner, spawn };
}

describe('LarkRunner', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('runs an allowed command without a shell and returns success data', async () => {
    const child = fakeProcess({
      stdout: JSON.stringify({ ok: true, identity: 'user', data: { spaces: [] } }),
    });
    const { runner, spawn } = runnerWith(child);

    await expect(runner.run({ id: 'wiki.spaceList' })).resolves.toEqual({ spaces: [] });
    expect(spawn).toHaveBeenCalledWith(
      '/opt/minori/lark-cli',
      ['wiki', '+space-list', '--format', 'json', '--as', 'user'],
      expect.objectContaining({
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: expect.objectContaining({ LARKSUITE_CLI_CONFIG_DIR: '/var/lib/minori/lark' }),
      }),
    );
  });

  it('turns the CLI stderr error envelope into a sanitized structured error', async () => {
    const child = fakeProcess({
      stderr: JSON.stringify({
        ok: false,
        identity: 'user',
        error: {
          type: 'api', subtype: 'permission', code: 99991679,
          message: 'secret-bearing upstream message', hint: 'grant scope',
        },
      }),
      code: 1,
    });
    const { runner } = runnerWith(child);

    const error = await runner.run({ id: 'wiki.spaceList' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error).toMatchObject({
      code: 'cli_error',
      details: { exitCode: 1, type: 'api', subtype: 'permission', upstreamCode: 99991679 },
    });
    expect(JSON.stringify(error)).not.toContain('secret-bearing');
    expect(JSON.stringify(error)).not.toContain('grant scope');
  });

  it('does not expose unrelated service secrets to the CLI environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    vi.stubEnv('DATABASE_URL', 'postgres://database-secret');
    const { runner, spawn } = runnerWith(fakeProcess({
      stdout: JSON.stringify(AUTH_STATUS),
    }));

    await expect(runner.run({ id: 'auth.status' })).resolves.toEqual(AUTH_STATUS);

    const options = spawn.mock.calls[0]?.[2];
    expect(options?.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(options?.env).not.toHaveProperty('DATABASE_URL');
    expect(options?.env).toMatchObject({
      LARKSUITE_CLI_CONFIG_DIR: '/var/lib/minori/lark',
    });
  });

  it('rejects malformed JSON with a stable error code', async () => {
    const { runner } = runnerWith(fakeProcess({ stdout: '{not-json' }));

    await expect(runner.run({ id: 'auth.status' })).rejects.toMatchObject({
      code: 'malformed_json',
    });
  });

  it('rejects a knowledge result that did not execute as the dedicated user', async () => {
    const { runner } = runnerWith(fakeProcess({
      stdout: JSON.stringify({ ok: true, identity: 'bot', data: {} }),
    }));

    await expect(runner.run({ id: 'wiki.spaceList' })).rejects.toMatchObject({
      code: 'invalid_envelope',
    });
  });

  it('rejects an incomplete official error envelope as contract drift', async () => {
    const { runner } = runnerWith(fakeProcess({
      stderr: JSON.stringify({ ok: false, error: {} }),
      code: 1,
    }));

    await expect(runner.run({ id: 'wiki.spaceList' })).rejects.toMatchObject({
      code: 'invalid_envelope',
    });
  });

  it('records only sanitized execution metadata', async () => {
    const onExecution = vi.fn();
    const { runner } = runnerWith(fakeProcess({
      stdout: JSON.stringify({ ok: true, identity: 'user', data: {} }),
    }), { onExecution });

    await runner.run({ id: 'drive.search', query: 'private roadmap phrase' });

    expect(onExecution).toHaveBeenCalledWith({
      commandId: 'drive.search', outcome: 'success', durationMs: expect.any(Number),
    });
    expect(JSON.stringify(onExecution.mock.calls)).not.toContain('private roadmap phrase');
  });

  it('contains a missing-binary spawn error without leaking its message', async () => {
    const child = fakeProcess();
    const { runner } = runnerWith(child);
    queueMicrotask(() => {
      (child as unknown as EventEmitter).emit('error', new Error('ENOENT /secret/path'));
    });

    const error = await runner.run({ id: 'auth.status' }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(LarkCliError);
    expect(error).toMatchObject({ code: 'spawn_failed' });
    expect(JSON.stringify(error)).not.toContain('/secret/path');
  });

  it('kills a timed-out process and reports timeout distinctly', async () => {
    vi.useFakeTimers();
    const child = fakeProcess();
    const { runner } = runnerWith(child, { timeoutMs: 25 });

    const result = runner.run({ id: 'auth.status' });
    const rejection = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills a caller-cancelled process and reports cancellation distinctly', async () => {
    const child = fakeProcess();
    const { runner } = runnerWith(child);
    const controller = new AbortController();

    const result = runner.run({ id: 'auth.status' }, controller.signal);
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: 'aborted' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('escalates cancellation when the CLI ignores SIGTERM', async () => {
    vi.useFakeTimers();
    const child = fakeProcess();
    child.kill.mockImplementation((signal?: NodeJS.Signals) => {
      if (signal === 'SIGKILL') {
        queueMicrotask(() => child.emit('close', null));
      }
      return true;
    });
    const { runner } = runnerWith(child);
    const controller = new AbortController();

    const result = runner.run({ id: 'auth.status' }, controller.signal);
    const rejection = expect(result).rejects.toMatchObject({ code: 'aborted' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  });

  it('kills a process whose combined output exceeds the byte limit', async () => {
    const child = fakeProcess({
      stdout: JSON.stringify({ ok: true, data: { value: 'too-large' } }),
    });
    const { runner } = runnerWith(child, { maxOutputBytes: 8 });

    await expect(runner.run({ id: 'auth.status' })).rejects.toMatchObject({
      code: 'output_limit',
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
