import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthCommandRunner } from '../../scripts/lark-auth.js';

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

describe('Lark auth child HOME', () => {
  it('creates a missing inherited HOME as mode 0700 before starting the CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-home-'));
    const home = join(root, 'home');
    const child = fakeChild();
    vi.stubEnv('HOME', home);
    vi.mocked(spawn).mockReturnValue(child as never);

    try {
      const result = createAuthCommandRunner('lark-cli', '/config', '/data')
        .runText(['auth', 'status']);

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
      const result = createAuthCommandRunner('lark-cli', '/config', '/data')
        .runText(['auth', 'status']);

      expect(statSync(home).mode & 0o777).toBe(0o700);
      queueMicrotask(() => child.emit('close', 0));
      await result;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a relative inherited HOME before starting the CLI', async () => {
    const relativeHome = '../minori-lark-auth-relative-home-test';
    const createdPath = join(process.cwd(), relativeHome);
    const child = fakeChild();
    vi.stubEnv('HOME', relativeHome);
    vi.mocked(spawn).mockClear();
    vi.mocked(spawn).mockReturnValue(child as never);
    queueMicrotask(() => child.emit('close', 0));

    try {
      await expect(createAuthCommandRunner('lark-cli', '/config', '/data')
        .runText(['auth', 'status']))
        .rejects.toThrow('lark_auth_home_must_be_absolute');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(createdPath, { recursive: true, force: true });
    }
  });

  it('redacts filesystem details when the inherited HOME cannot be secured', async () => {
    const root = mkdtempSync(join(tmpdir(), 'minori-lark-auth-home-'));
    const home = join(root, 'not-a-directory');
    writeFileSync(home, 'occupied');
    vi.stubEnv('HOME', home);
    vi.mocked(spawn).mockClear();

    try {
      let failure: unknown;
      try {
        await createAuthCommandRunner('lark-cli', '/config', '/data')
          .runText(['auth', 'status']);
      } catch (error) {
        failure = error;
      }

      expect(failure).toEqual(new Error('lark_auth_home_unavailable'));
      expect(String(failure)).not.toContain(home);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
