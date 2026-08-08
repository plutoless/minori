import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthCommandRunner, runLarkAuth } from '../../scripts/lark-auth.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}

function runnerForHome(home: string) {
  const storeRoot = dirname(home);
  return createAuthCommandRunner(
    'lark-cli', join(storeRoot, 'config'), join(storeRoot, 'data'),
  );
}

describe('Lark auth child HOME', () => {
  it('creates a missing inherited HOME as mode 0700 before starting the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-home-'));
    const home = join(root, 'home');
    const child = fakeChild();
    vi.stubEnv('HOME', home);
    vi.mocked(spawn).mockReturnValue(child as never);

    try {
      const result = runnerForHome(home).runText(['auth', 'status']);

      expect(statSync(home).mode & 0o777).toBe(0o700);
      queueMicrotask(() => child.emit('close', 0));
      await result;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tightens an existing mode-0755 HOME before starting the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-home-'));
    const home = join(root, 'home');
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const child = fakeChild();
    vi.stubEnv('HOME', home);
    vi.mocked(spawn).mockReturnValue(child as never);

    try {
      const result = runnerForHome(home).runText(['auth', 'status']);

      expect(statSync(home).mode & 0o777).toBe(0o700);
      queueMicrotask(() => child.emit('close', 0));
      await result;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a relative inherited HOME before starting the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-relative-home-'));
    const relativeHome = relative(process.cwd(), join(root, 'home'));
    const child = fakeChild();
    vi.stubEnv('HOME', relativeHome);
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(child as never);
    queueMicrotask(() => child.emit('close', 0));

    try {
      await expect(runnerForHome(relativeHome).runText(['auth', 'status']))
        .rejects.toThrow('lark_auth_home_must_be_absolute');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves the sanitized HOME category through the operator auth flow', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-relative-home-'));
    const relativeHome = relative(process.cwd(), join(root, 'home'));
    vi.stubEnv('HOME', relativeHome);
    vi.mocked(spawn).mockClear();

    try {
      await expect(runLarkAuth(runnerForHome(relativeHome), {
        configDir: '/var/lib/minori/lark/config',
        dataDir: '/var/lib/minori/lark/data',
        appId: 'cli_existing',
        appSecret: 'secret-from-env',
      }, vi.fn())).rejects.toThrow('lark_auth_home_must_be_absolute');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked HOME without changing its target or starting the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-home-'));
    const target = join(root, 'target');
    const home = join(root, 'home');
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, home, 'dir');
    const child = fakeChild();
    vi.stubEnv('HOME', home);
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(child as never);
    queueMicrotask(() => child.emit('close', 0));

    try {
      await expect(runnerForHome(home).runText(['auth', 'status']))
        .rejects.toThrow('lark_auth_home_unsafe');
      expect(statSync(target).mode & 0o777).toBe(0o755);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked HOME ancestor without creating outside that path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-home-'));
    const target = join(root, 'target');
    const linkedParent = join(root, 'linked-parent');
    const home = join(linkedParent, 'home');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, linkedParent, 'dir');
    const child = fakeChild();
    vi.stubEnv('HOME', home);
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(child as never);
    queueMicrotask(() => child.emit('close', 0));

    try {
      await expect(runnerForHome(home).runText(['auth', 'status']))
        .rejects.toThrow('lark_auth_home_unsafe');
      expect(existsSync(join(target, 'home'))).toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a non-directory HOME without exposing its path or starting the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-home-'));
    const home = join(root, 'not-a-directory');
    writeFileSync(home, 'occupied');
    vi.stubEnv('HOME', home);
    vi.mocked(spawn).mockClear();

    try {
      let failure: unknown;
      try {
        await runnerForHome(home).runText(['auth', 'status']);
      } catch (error) {
        failure = error;
      }

      expect(failure).toEqual(new Error('lark_auth_home_unsafe'));
      expect(String(failure)).not.toContain(home);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
