import { describe, expect, it, vi } from 'vitest';
import { runLarkAuth, type AuthCommandRunner } from '../../scripts/lark-auth.js';

describe('runLarkAuth', () => {
  it('prints only verification URLs and a sanitized final identity status', async () => {
    const calls: string[][] = [];
    const runner: AuthCommandRunner = {
      runStreaming: vi.fn(async (args, onUrl) => {
        calls.push(args);
        onUrl('https://open.feishu.cn/config-device');
      }),
      runJson: vi.fn(async (args) => {
        calls.push(args);
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

    await runLarkAuth(runner, '/var/lib/minori/lark', (line) => printed.push(line));

    expect(calls).toEqual([
      ['config', 'init', '--new'],
      ['auth', 'login', '--recommend', '--no-wait', '--json'],
      ['auth', 'login', '--device-code', 'device-secret', '--json'],
      ['auth', 'status', '--json', '--verify'],
    ]);
    expect(printed).toEqual([
      'https://open.feishu.cn/config-device',
      'https://accounts.feishu.cn/device?code=ABCD',
      '{"identity":"user","defaultAs":"user","userAvailable":true}',
    ]);
    expect(JSON.stringify(printed)).not.toContain('secret');
    expect(JSON.stringify(printed)).not.toContain('token');
  });

  it('rejects a relative credential directory', async () => {
    await expect(runLarkAuth({} as AuthCommandRunner, './lark', vi.fn()))
      .rejects.toThrow('lark_config_dir_must_be_absolute');
  });
});
