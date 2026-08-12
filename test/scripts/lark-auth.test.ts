import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, openSync, writeSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAuthCommandRunner, runLarkAuth, writeVerificationUrlToOperatorTerminal,
  type AuthCommandRunner,
} from '../../scripts/lark-auth.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    constants: actual.constants,
    closeSync: vi.fn(),
    fchmodSync: vi.fn(),
    fstatSync: vi.fn(),
    lstatSync: vi.fn(),
    mkdirSync: vi.fn(),
    openSync: vi.fn(),
    writeSync: vi.fn(),
  };
});

beforeEach(async () => {
  const fs = await import('node:fs');
  const root = {
    dev: 1, ino: 10, isDirectory: () => true, isSymbolicLink: () => false,
  };
  const home = {
    dev: 1, ino: 11, isDirectory: () => true, isSymbolicLink: () => false,
  };
  vi.mocked(fs.lstatSync).mockImplementation((path) => (
    String(path).endsWith('/home') ? home : root
  ) as never);
  vi.mocked(fs.fstatSync).mockReturnValue(home as never);
  vi.mocked(openSync).mockReturnValue(17 as never);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runLarkAuth', () => {
  const meetingScopes = [
    'contact:user:search',
    'vc:meeting.search:read',
    'vc:meeting.meetingevent:read',
    'vc:record:readonly',
    'vc:note:read',
    'minutes:minutes.search:read',
    'minutes:minutes.basic:read',
    'minutes:minutes.transcript:export',
  ].join(',');

  it('hands the CLI 1.0.84 verification_url to the operator terminal and completes device auth', async () => {
    vi.mocked(openSync).mockReturnValue(18 as never);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const runner: AuthCommandRunner = {
      runText: vi.fn(async () => ''),
      runJson: vi.fn(async (args) => {
        if (args.includes('--no-wait')) {
          return {
            verification_url: 'https://accounts.feishu.cn/device?code=REAL84',
            device_code: 'device-secret',
          };
        }
        if (args.includes('--device-code')) return { ok: true };
        return { identity: 'user', identities: { user: { available: true } } };
      }),
    };
    let logged = '';

    try {
      await runLarkAuth(runner, {
        configDir: '/var/lib/minori/lark/config',
        dataDir: '/var/lib/minori/lark/data',
        appId: 'cli_existing',
        appSecret: 'secret-from-env',
      }, (line) => {
        if (line.startsWith('https://')) writeVerificationUrlToOperatorTerminal(line);
        else console.log(line);
      });
    } finally {
      logged = JSON.stringify(log.mock.calls);
      log.mockRestore();
    }

    expect(writeSync).toHaveBeenCalledWith(
      18, 'https://accounts.feishu.cn/device?code=REAL84\n',
    );
    expect(runner.runJson).toHaveBeenCalledWith([
      'auth', 'login', '--device-code', 'device-secret', '--json',
    ]);
    expect(logged).not.toContain('REAL84');
  });

  it('binds the existing app and emits only the device URL and sanitized user status through its callback', async () => {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const stdinValues: string[] = [];
    const runner: AuthCommandRunner = {
      runText: vi.fn(async (args, input) => {
        calls.push({ args, input });
        if (input) stdinValues.push(input);
        return '';
      }),
      runJson: vi.fn(async (args) => {
        calls.push({ args });
        if (args.includes('--no-wait')) {
          return {
            verification_uri_complete: 'https://accounts.feishu.cn/device?code=ABCD',
            device_code: 'device-secret',
            access_token: 'must-not-print',
          };
        }
        if (args.includes('--device-code')) return { ok: true, refresh_token: 'hidden' };
        return {
          identity: 'user', defaultAs: 'user',
          identities: { user: { available: true }, bot: { available: true } },
          access_token: 'hidden',
        };
      }),
    };
    const printed: string[] = [];
    const config = {
      configDir: '/var/lib/minori/lark/config',
      dataDir: '/var/lib/minori/lark/data',
      appId: 'cli_existing',
      appSecret: 'secret-from-env',
    };

    await runLarkAuth(runner, config, printed.push.bind(printed));

    expect(calls.map(({ args }) => args)).toEqual([
      ['config', 'init', '--app-id', 'cli_existing', '--app-secret-stdin', '--brand', 'feishu'],
      ['config', 'strict-mode', 'user'],
      ['auth', 'login', '--domain', 'docs,drive,wiki', '--scope', meetingScopes, '--no-wait', '--json'],
      ['auth', 'login', '--device-code', 'device-secret', '--json'],
      ['auth', 'status', '--json', '--verify'],
    ]);
    expect(stdinValues).toEqual(['secret-from-env\n']);
    expect(printed).toEqual([
      'https://accounts.feishu.cn/device?code=ABCD',
      '{"identity":"user","userAvailable":true}',
    ]);
    expect(JSON.stringify({ args: calls.map(({ args }) => args), printed })).not.toContain('secret-from-env');
    expect(JSON.stringify(printed)).not.toContain('device-secret');
    const login = calls.find(({ args }) => args.includes('--no-wait'))?.args.join(' ') ?? '';
    expect(login).not.toMatch(
      /contact:contact|vc:meeting:(?:write|update)|minutes:(?:media|upload)|calendar|permission|:write/iu,
    );
  });

  it.each([
    ['missing app ID', { appId: '' }, 'lark_app_id_required'],
    ['missing app secret', { appSecret: '' }, 'lark_app_secret_required'],
    ['relative config directory', { configDir: './config' }, 'lark_config_dir_must_be_absolute'],
    ['relative data directory', { dataDir: './data' }, 'lark_data_dir_must_be_absolute'],
  ])('fails with a stable code for %s', async (_label, override, code) => {
    const runner = { runText: vi.fn(), runJson: vi.fn() } as AuthCommandRunner;

    await expect(runLarkAuth(runner, {
      configDir: '/var/lib/minori/lark/config',
      dataDir: '/var/lib/minori/lark/data',
      appId: 'cli_existing',
      appSecret: 'secret-from-env',
      ...override,
    }, vi.fn())).rejects.toThrow(code);

    expect(runner.runText).not.toHaveBeenCalled();
    expect(runner.runJson).not.toHaveBeenCalled();
  });

  it('fails with a stable code when the device authorization response is invalid', async () => {
    const runner: AuthCommandRunner = {
      runText: vi.fn(async () => ''),
      runJson: vi.fn(async () => ({ verification_uri_complete: 'https://accounts.feishu.cn/device?code=ABCD' })),
    };

    await expect(runLarkAuth(runner, {
      configDir: '/var/lib/minori/lark/config',
      dataDir: '/var/lib/minori/lark/data',
      appId: 'cli_existing',
      appSecret: 'secret-from-env',
    }, vi.fn())).rejects.toThrow('lark_device_authorization_invalid');
  });

  it('preserves the stable invalid-JSON code from the command runner', async () => {
    const runner: AuthCommandRunner = {
      runText: vi.fn(async () => ''),
      runJson: vi.fn(async () => { throw new Error('lark_auth_invalid_json'); }),
    };

    await expect(runLarkAuth(runner, {
      configDir: '/var/lib/minori/lark/config',
      dataDir: '/var/lib/minori/lark/data',
      appId: 'cli_existing',
      appSecret: 'secret-from-env',
    }, vi.fn())).rejects.toThrow('lark_auth_invalid_json');
  });

  it('fails with a stable code when final status is not an available user identity', async () => {
    const runner: AuthCommandRunner = {
      runText: vi.fn(async () => ''),
      runJson: vi.fn(async (args) => {
        if (args.includes('--no-wait')) {
          return {
            verification_uri_complete: 'https://accounts.feishu.cn/device?code=ABCD',
            device_code: 'device-secret',
          };
        }
        if (args.includes('--verify')) {
          return { identity: 'bot', identities: { user: { available: true } } };
        }
        return { ok: true };
      }),
    };

    await expect(runLarkAuth(runner, {
      configDir: '/var/lib/minori/lark/config',
      dataDir: '/var/lib/minori/lark/data',
      appId: 'cli_existing',
      appSecret: 'secret-from-env',
    }, vi.fn())).rejects.toThrow('lark_auth_user_identity_required');
  });

  it('redacts a runner error behind a stable code', async () => {
    const runner: AuthCommandRunner = {
      runText: vi.fn(async () => { throw new Error('secret-from-runner'); }),
      runJson: vi.fn(),
    };

    await expect(runLarkAuth(runner, {
      configDir: '/var/lib/minori/lark/config',
      dataDir: '/var/lib/minori/lark/data',
      appId: 'cli_existing',
      appSecret: 'secret-from-env',
    }, vi.fn())).rejects.toThrow('lark_auth_command_failed');
  });

  it.each([
    'lark_auth_home_must_be_absolute',
    'lark_auth_home_unsafe',
    'lark_auth_home_unavailable',
  ])('preserves the sanitized operator HOME failure %s', async (code) => {
    const runner: AuthCommandRunner = {
      runText: vi.fn(async () => { throw new Error(code); }),
      runJson: vi.fn(),
    };

    await expect(runLarkAuth(runner, {
      configDir: '/var/lib/minori/lark/config',
      dataDir: '/var/lib/minori/lark/data',
      appId: 'cli_existing',
      appSecret: 'secret-from-env',
    }, vi.fn())).rejects.toThrow(code);
  });

  it('passes the persistent Lark home through to the CLI', async () => {
    vi.stubEnv('HOME', '/var/lib/minori/lark/home');
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as never);

    const result = createAuthCommandRunner(
      'lark-cli', '/var/lib/minori/lark/config', '/var/lib/minori/lark/data',
    ).runText(['auth', 'status']);
    queueMicrotask(() => child.emit('close', 0));
    await result;

    expect(vi.mocked(spawn).mock.lastCall?.[2]?.env).toMatchObject({
      HOME: '/var/lib/minori/lark/home',
    });
  });

  it('rejects a HOME pathname replacement detected before starting the CLI', async () => {
    vi.stubEnv('HOME', '/var/lib/minori/lark/home');
    const fs = await import('node:fs');
    const root = {
      dev: 1, ino: 10, isDirectory: () => true, isSymbolicLink: () => false,
    };
    const openedHome = {
      dev: 1, ino: 11, isDirectory: () => true, isSymbolicLink: () => false,
    };
    const replacement = {
      dev: 1, ino: 12, isDirectory: () => true, isSymbolicLink: () => false,
    };
    let homeReads = 0;
    vi.mocked(fs.lstatSync).mockImplementation((path) => {
      if (!String(path).endsWith('/home')) return root as never;
      homeReads += 1;
      return (homeReads === 1 ? openedHome : replacement) as never;
    });
    vi.mocked(fs.fstatSync).mockReturnValue(openedHome as never);
    vi.mocked(spawn).mockClear();

    await expect(createAuthCommandRunner(
      'lark-cli', '/var/lib/minori/lark/config', '/var/lib/minori/lark/data',
    ).runText(['auth', 'status'])).rejects.toThrow('lark_auth_home_unsafe');

    expect(fs.fchmodSync).toHaveBeenCalledWith(17, 0o700);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('converts an early stdin close into a stable runner error', async () => {
    vi.stubEnv('HOME', '/var/lib/minori/lark/home');
    const stdin = Object.assign(new EventEmitter(), {
      end: vi.fn(() => stdin.emit('error', new Error('EPIPE'))),
    });
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockReturnValue(child as never);

    await expect(createAuthCommandRunner(
      'lark-cli', '/var/lib/minori/lark/config', '/var/lib/minori/lark/data',
    ).runText(
      ['config', 'init'], 'secret-from-env\n',
    )).rejects.toThrow('lark_auth_command_failed');
  });

  it('hands the verification URL only to the interactive operator terminal', () => {
    vi.mocked(openSync).mockReturnValue(18 as never);

    writeVerificationUrlToOperatorTerminal('https://accounts.feishu.cn/device?code=ABCD');

    expect(openSync).toHaveBeenCalledWith('/dev/tty', 'w');
    expect(writeSync).toHaveBeenCalledWith(18, 'https://accounts.feishu.cn/device?code=ABCD\n');
    expect(closeSync).toHaveBeenCalledWith(18);
  });

  it('fails with a stable code when no operator terminal is available', () => {
    vi.mocked(openSync).mockImplementation(() => { throw new Error('ENXIO'); });

    expect(() => writeVerificationUrlToOperatorTerminal(
      'https://accounts.feishu.cn/device?code=ABCD',
    )).toThrow('lark_auth_operator_tty_required');
  });
});
