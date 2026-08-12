import { spawn } from 'node:child_process';
import {
  closeSync, constants as fsConstants, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
const MEETING_READ_SCOPES = Object.freeze([
  'contact:user:search',
  'vc:meeting.search:read',
  'vc:meeting.meetingevent:read',
  'vc:note:read',
  'vc:meeting.artifact.verbatim:read',
  'vc:note:read',
  'minutes:minutes.search:read',
  'minutes:minutes.basic:read',
  'minutes:minutes.transcript:export',
] as const);
const STABLE_RUNNER_ERRORS = new Set([
  'lark_auth_spawn_failed',
  'lark_auth_output_limit',
  'lark_auth_command_failed',
  'lark_auth_invalid_json',
  'lark_auth_home_must_be_absolute',
  'lark_auth_home_unsafe',
  'lark_auth_home_unavailable',
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

function stableHomeFailure(error: unknown): Error {
  if (error instanceof Error && error.message === 'lark_auth_home_unsafe') return error;
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  if (code === 'ELOOP' || code === 'ENOTDIR') return new Error('lark_auth_home_unsafe');
  return new Error('lark_auth_home_unavailable');
}

function sameInode(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

// O_NOFOLLOW prevents following a final HOME symlink, and fchmod applies only to the
// opened directory inode. The final dev/ino checks detect a changed store root or HOME
// pathname before spawn. Node exposes no openat2-style atomic path resolution here, so
// the operator-protected store parent must also prevent a concurrent swap-and-restore.
function prepareLarkHome(home: string | undefined, dataDir: string): void {
  if (!home || !isAbsolute(home)) throw new Error('lark_auth_home_must_be_absolute');
  if (!isAbsolute(dataDir)) throw new Error('lark_auth_home_unsafe');

  const storeRoot = dirname(resolve(dataDir));
  if (resolve(dataDir) !== dataDir || resolve(home) !== home || home !== join(storeRoot, 'home')) {
    throw new Error('lark_auth_home_unsafe');
  }

  let descriptor: number | undefined;
  let failure: Error | undefined;
  try {
    const rootBefore = lstatSync(storeRoot);
    if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
      throw new Error('lark_auth_home_unsafe');
    }

    const entryBefore = lstatSync(home, { throwIfNoEntry: false });
    if (entryBefore && (entryBefore.isSymbolicLink() || !entryBefore.isDirectory())) {
      throw new Error('lark_auth_home_unsafe');
    }
    if (!entryBefore) {
      try {
        mkdirSync(home, { mode: 0o700 });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? String(error.code)
          : '';
        if (code !== 'EEXIST') throw error;
      }
    }

    descriptor = openSync(
      home,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) throw new Error('lark_auth_home_unsafe');
    fchmodSync(descriptor, 0o700);

    const rootAfter = lstatSync(storeRoot);
    const entryAfter = lstatSync(home);
    if (
      rootAfter.isSymbolicLink() || !rootAfter.isDirectory()
      || entryAfter.isSymbolicLink() || !entryAfter.isDirectory()
      || !sameInode(rootBefore, rootAfter) || !sameInode(opened, entryAfter)
    ) {
      throw new Error('lark_auth_home_unsafe');
    }
  } catch (error) {
    failure = stableHomeFailure(error);
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch {
      failure ??= new Error('lark_auth_home_unavailable');
    }
  }
  if (failure) throw failure;
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
    'auth', 'login', '--domain', 'docs,drive,wiki',
    '--scope', MEETING_READ_SCOPES.join(','), '--no-wait', '--json',
  ]));
  const verificationUrl = findString(login, new Set([
    'verification_url', 'verification_uri_complete', 'verification_uri',
    'verificationUrl', 'authorization_url',
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
    prepareLarkHome(environment.HOME, dataDir);
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
