import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export type LarkAuthConfig = {
  configDir: string;
  dataDir: string;
  appId: string;
  appSecret: string;
};

export interface AuthCommandRunner {
  runText(args: string[], input?: string, onUrl?: (url: string) => void): Promise<string>;
  runJson(args: string[], input?: string): Promise<unknown>;
}

const URL_PATTERN = /https:\/\/[^\s"'<>]+/gu;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const STABLE_RUNNER_ERRORS = new Set([
  'lark_auth_spawn_failed',
  'lark_auth_output_limit',
  'lark_auth_command_failed',
  'lark_auth_invalid_json',
]);

function findString(value: unknown, keys: Set<string>): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (keys.has(key) && typeof nested === 'string') return nested;
    const found = findString(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function stableCommandFailure<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (error instanceof Error && STABLE_RUNNER_ERRORS.has(error.message)) throw error;
    throw new Error('lark_auth_command_failed');
  });
}

export function writeVerificationUrlToOperatorTerminal(url: string): void {
  let terminal: number | undefined;
  try {
    terminal = openSync('/dev/tty', 'w');
    writeSync(terminal, `${url}\n`);
  } catch {
    throw new Error('lark_auth_operator_tty_required');
  } finally {
    if (terminal !== undefined) {
      try {
        closeSync(terminal);
      } catch {
        // The URL handoff already succeeded and must not be reported through stdout or stderr.
      }
    }
  }
}

export async function runLarkAuth(
  runner: AuthCommandRunner,
  config: LarkAuthConfig,
  print: (line: string) => void,
): Promise<void> {
  if (!isAbsolute(config.configDir)) throw new Error('lark_config_dir_must_be_absolute');
  if (!isAbsolute(config.dataDir)) throw new Error('lark_data_dir_must_be_absolute');
  if (!config.appId.trim()) throw new Error('lark_app_id_required');
  if (!config.appSecret.trim()) throw new Error('lark_app_secret_required');

  await stableCommandFailure(() => runner.runText([
    'config', 'init', '--app-id', config.appId, '--app-secret-stdin', '--brand', 'feishu',
  ], `${config.appSecret}\n`));
  await stableCommandFailure(() => runner.runText(['config', 'strict-mode', 'user']));

  const login = await stableCommandFailure(() => runner.runJson([
    'auth', 'login', '--domain', 'docs,drive,wiki', '--no-wait', '--json',
  ]));
  const verificationUrl = findString(login, new Set([
    'verification_uri_complete', 'verification_uri', 'verificationUrl', 'authorization_url',
  ]));
  const deviceCode = findString(login, new Set(['device_code', 'deviceCode']));
  if (!verificationUrl || !deviceCode) throw new Error('lark_device_authorization_invalid');
  print(verificationUrl);

  await stableCommandFailure(() => runner.runJson([
    'auth', 'login', '--device-code', deviceCode, '--json',
  ]));
  const status = await stableCommandFailure(() => runner.runJson([
    'auth', 'status', '--json', '--verify',
  ]));
  const record = status && typeof status === 'object'
    ? status as Record<string, unknown>
    : {};
  const identities = record.identities && typeof record.identities === 'object'
    ? record.identities as Record<string, unknown>
    : {};
  const user = identities.user && typeof identities.user === 'object'
    ? identities.user as Record<string, unknown>
    : {};
  const userAvailable = user.available === true;
  if (record.identity !== 'user' || !userAvailable) {
    throw new Error('lark_auth_user_identity_required');
  }
  print(JSON.stringify({ identity: 'user', userAvailable }));
}

export function createAuthCommandRunner(
  binary: string,
  configDir: string,
  dataDir: string,
): AuthCommandRunner {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LARKSUITE_CLI_CONFIG_DIR: configDir,
    LARKSUITE_CLI_DATA_DIR: dataDir,
  };

  function run(
    args: string[],
    input?: string,
    onChunk?: (text: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, {
        shell: false,
        env: environment,
        stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      });
      const childStdout = child.stdout;
      const childStderr = child.stderr;
      const childStdin = child.stdin;
      const stdout: Buffer[] = [];
      let size = 0;
      let finished = false;
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        reject(error);
      };
      if (!childStdout || !childStderr || (input !== undefined && !childStdin)) {
        child.kill('SIGKILL');
        fail(new Error('lark_auth_spawn_failed'));
        return;
      }
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
      childStdout.on('data', (chunk: Buffer | string) => collect('stdout', chunk));
      childStderr.on('data', (chunk: Buffer | string) => collect('stderr', chunk));
      child.once('error', () => fail(new Error('lark_auth_spawn_failed')));
      child.once('close', (code) => {
        if (finished) return;
        finished = true;
        if (size > MAX_OUTPUT_BYTES) reject(new Error('lark_auth_output_limit'));
        else if (code !== 0) reject(new Error('lark_auth_command_failed'));
        else resolve(Buffer.concat(stdout).toString('utf8'));
      });
      if (input !== undefined) {
        childStdin!.once('error', () => fail(new Error('lark_auth_command_failed')));
        childStdin!.end(input);
      }
    });
  }

  return {
    async runText(args, input, onUrl) {
      const seen = new Set<string>();
      const pending = { stdout: '', stderr: '' };
      const emit = (text: string) => {
        for (const url of text.match(URL_PATTERN) ?? []) {
          if (!seen.has(url)) {
            seen.add(url);
            onUrl?.(url);
          }
        }
      };
      const output = await run(args, input, (text, stream) => {
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
      return output;
    },
    async runJson(args, input) {
      const output = await run(args, input);
      try {
        return JSON.parse(output);
      } catch {
        throw new Error('lark_auth_invalid_json');
      }
    },
  };
}

async function main() {
  const config: LarkAuthConfig = {
    configDir: process.env.LARKSUITE_CLI_CONFIG_DIR ?? '/var/lib/minori/lark/config',
    dataDir: process.env.LARKSUITE_CLI_DATA_DIR ?? '/var/lib/minori/lark/data',
    appId: process.env.FEISHU_APP_ID ?? '',
    appSecret: process.env.FEISHU_APP_SECRET ?? '',
  };
  const binary = process.env.LARK_CLI_BIN ?? 'lark-cli';
  await runLarkAuth(createAuthCommandRunner(binary, config.configDir, config.dataDir), config, (line) => {
    if (line.startsWith('https://')) writeVerificationUrlToOperatorTerminal(line);
    else console.log(line);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'lark_auth_failed');
    process.exitCode = 1;
  });
}
