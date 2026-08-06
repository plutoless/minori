import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface AuthCommandRunner {
  runStreaming(args: string[], onUrl: (url: string) => void): Promise<void>;
  runJson(args: string[]): Promise<unknown>;
}

const URL_PATTERN = /https:\/\/[^\s"'<>]+/gu;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

function findString(value: unknown, keys: Set<string>): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key) && typeof nested === 'string') return nested;
    const found = findString(nested, keys);
    if (found) return found;
  }
  return undefined;
}

export async function runLarkAuth(
  runner: AuthCommandRunner,
  configDir: string,
  print: (line: string) => void,
) {
  if (!isAbsolute(configDir)) throw new Error('lark_config_dir_must_be_absolute');
  await runner.runStreaming(['config', 'init', '--new'], print);
  const login = await runner.runJson([
    'auth', 'login', '--recommend', '--no-wait', '--json',
  ]);
  const verificationUrl = findString(login, new Set([
    'verification_uri_complete', 'verification_uri', 'verificationUrl', 'authorization_url',
  ]));
  const deviceCode = findString(login, new Set(['device_code', 'deviceCode']));
  if (!verificationUrl || !deviceCode) throw new Error('lark_device_authorization_invalid');
  print(verificationUrl);
  await runner.runJson(['auth', 'login', '--device-code', deviceCode, '--json']);
  const status = await runner.runJson(['auth', 'status', '--json', '--verify']);
  const record = status && typeof status === 'object'
    ? status as Record<string, unknown>
    : {};
  const identities = record.identities && typeof record.identities === 'object'
    ? record.identities as Record<string, unknown>
    : {};
  const user = identities.user && typeof identities.user === 'object'
    ? identities.user as Record<string, unknown>
    : {};
  print(JSON.stringify({
    identity: typeof record.identity === 'string' ? record.identity : 'none',
    defaultAs: typeof record.defaultAs === 'string' ? record.defaultAs : 'none',
    userAvailable: user.available === true,
  }));
}

export function createAuthCommandRunner(binary: string, configDir: string): AuthCommandRunner {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    LARKSUITE_CLI_CONFIG_DIR: configDir,
  };

  function run(
    args: string[],
    onChunk?: (text: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        shell: false,
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let size = 0;
      const collect = (stream: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          return;
        }
        if (stream === 'stdout') stdout.push(buffer);
        onChunk?.(buffer.toString('utf8'), stream);
      };
      child.stdout.on('data', (chunk: Buffer | string) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer | string) => collect('stderr', chunk));
      child.once('error', () => reject(new Error('lark_auth_spawn_failed')));
      child.once('close', (code) => {
        if (size > MAX_OUTPUT_BYTES) reject(new Error('lark_auth_output_limit'));
        else if (code !== 0) reject(new Error('lark_auth_command_failed'));
        else resolve(Buffer.concat(stdout).toString('utf8'));
      });
    });
  }

  return {
    async runStreaming(args, onUrl) {
      const seen = new Set<string>();
      const pending = { stdout: '', stderr: '' };
      const emit = (text: string) => {
        for (const url of text.match(URL_PATTERN) ?? []) {
          if (!seen.has(url)) {
            seen.add(url);
            onUrl(url);
          }
        }
      };
      await run(args, (text, stream) => {
        const combined = pending[stream] + text;
        const lastLineBreak = Math.max(combined.lastIndexOf('\n'), combined.lastIndexOf('\r'));
        if (lastLineBreak < 0) {
          pending[stream] = combined.slice(-8192);
          return;
        }
        emit(combined.slice(0, lastLineBreak + 1));
        pending[stream] = combined.slice(lastLineBreak + 1, lastLineBreak + 8193);
      });
      emit(pending.stdout);
      emit(pending.stderr);
    },
    async runJson(args) {
      const output = await run(args);
      try {
        return JSON.parse(output);
      } catch {
        throw new Error('lark_auth_invalid_json');
      }
    },
  };
}

async function main() {
  const configDir = process.env.LARKSUITE_CLI_CONFIG_DIR ?? '/var/lib/minori/lark';
  const binary = process.env.LARK_CLI_BIN ?? 'lark-cli';
  await runLarkAuth(createAuthCommandRunner(binary, configDir), configDir, console.log);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('lark_auth_failed');
    process.exitCode = 1;
  });
}
