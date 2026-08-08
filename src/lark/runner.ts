import type { spawn } from 'node:child_process';
import { z } from 'zod';
import { buildInvocation, type LarkCommand } from './command-catalog.js';
import { LarkCliError, type LarkCliErrorCode } from './errors.js';

const larkErrorSchema = z.object({
  type: z.string(),
  subtype: z.string(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string(),
  hint: z.string().optional(),
}).passthrough();

const larkEnvelopeSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true), identity: z.string().optional(), data: z.unknown(),
  }).passthrough(),
  z.object({
    ok: z.literal(false), identity: z.string().optional(), error: larkErrorSchema,
  }).passthrough(),
]);

const authIdentityStatusSchema = z.object({
  status: z.string(),
  available: z.boolean(),
}).passthrough();

const authStatusSchema = z.object({
  appId: z.string(),
  brand: z.string(),
  defaultAs: z.string(),
  identity: z.enum(['user', 'bot', 'none']),
  identities: z.object({
    user: authIdentityStatusSchema,
    bot: authIdentityStatusSchema,
  }).passthrough(),
}).passthrough();

export interface SpawnedProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  stdin?: {
    end(input?: string): void;
    on(event: 'error', listener: () => void): unknown;
  };
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'close', listener: (code: number | null) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  removeListener(event: 'close', listener: (code: number | null) => void): this;
  removeListener(event: 'error', listener: (error: Error) => void): this;
}

export interface LarkExecutor {
  run<T>(command: LarkCommand, signal?: AbortSignal): Promise<T>;
}

export type LarkRunnerOptions = {
  binary: string;
  configDir: string;
  timeoutMs: number;
  maxOutputBytes: number;
  spawn: typeof spawn;
  onExecution?: (metadata: LarkExecutionMetadata) => void;
};

export type LarkExecutionMetadata = {
  commandId: LarkCommand['id'];
  outcome: 'success' | LarkCliErrorCode | 'unexpected_error';
  durationMs: number;
};

type TerminationReason = Extract<LarkCliErrorCode, 'aborted' | 'output_limit' | 'timeout'>;

const ABORT_KILL_GRACE_MS = 1_000;
const CHILD_ENV_KEYS = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const;

function buildChildEnvironment(configDir: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LARKSUITE_CLI_CONFIG_DIR: configDir,
  };
  const dataDir = process.env.LARKSUITE_CLI_DATA_DIR;
  if (dataDir !== undefined) environment.LARKSUITE_CLI_DATA_DIR = dataDir;
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export class LarkRunner implements LarkExecutor {
  constructor(private readonly options: LarkRunnerOptions) {}

  async run<T>(command: LarkCommand, signal?: AbortSignal): Promise<T> {
    const startedAt = Date.now();
    try {
      const data = await this.execute<T>(command, signal);
      this.recordExecution({
        commandId: command.id,
        outcome: 'success',
        durationMs: Date.now() - startedAt,
      });
      return data;
    } catch (error) {
      this.recordExecution({
        commandId: command.id,
        outcome: error instanceof LarkCliError ? error.code : 'unexpected_error',
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private async execute<T>(command: LarkCommand, signal?: AbortSignal): Promise<T> {
    const invocation = buildInvocation(command);
    let child: SpawnedProcess;
    try {
      child = this.options.spawn(this.options.binary, invocation.args, {
        shell: false,
        env: buildChildEnvironment(this.options.configDir),
        stdio: [invocation.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      }) as unknown as SpawnedProcess;
    } catch {
      throw new LarkCliError('spawn_failed');
    }

    if (invocation.stdin !== undefined) {
      if (!child.stdin) {
        child.kill('SIGKILL');
        throw new LarkCliError('spawn_failed');
      }
      child.stdin.on('error', () => undefined);
      try {
        child.stdin.end(invocation.stdin);
      } catch {
        child.kill('SIGKILL');
        throw new LarkCliError('spawn_failed');
      }
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let terminationReason: TerminationReason | undefined;
    let abortKillTimer: ReturnType<typeof setTimeout> | undefined;

    const terminate = (reason: TerminationReason, killSignal: NodeJS.Signals) => {
      if (terminationReason) return;
      terminationReason = reason;
      child.kill(killSignal);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > this.options.maxOutputBytes) {
        terminate('output_limit', 'SIGKILL');
      } else {
        target.push(buffer);
      }
    };
    const collectStdout = collect(stdout);
    const collectStderr = collect(stderr);
    child.stdout.on('data', collectStdout);
    child.stderr.on('data', collectStderr);

    const timer = setTimeout(
      () => terminate('timeout', 'SIGKILL'),
      this.options.timeoutMs,
    );
    timer.unref?.();
    const onAbort = () => {
      if (terminationReason) return;
      terminationReason = 'aborted';
      child.kill('SIGTERM');
      abortKillTimer = setTimeout(() => child.kill('SIGKILL'), ABORT_KILL_GRACE_MS);
      abortKillTimer.unref?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();

    let onClose!: (exitCode: number | null) => void;
    let onSpawnError!: (error: Error) => void;
    const outcome = await new Promise<
      { type: 'close'; exitCode: number | null } | { type: 'error' }
    >((resolve) => {
      onClose = (exitCode) => resolve({ type: 'close', exitCode });
      onSpawnError = () => resolve({ type: 'error' });
      child.once('close', onClose);
      child.once('error', onSpawnError);
    });
    clearTimeout(timer);
    if (abortKillTimer) clearTimeout(abortKillTimer);
    signal?.removeEventListener('abort', onAbort);
    child.removeListener('close', onClose);
    child.removeListener('error', onSpawnError);
    child.stdout.removeListener('data', collectStdout);
    child.stderr.removeListener('data', collectStderr);

    if (terminationReason) throw new LarkCliError(terminationReason);
    if (outcome.type === 'error') throw new LarkCliError('spawn_failed');
    const { exitCode } = outcome;

    const output = Buffer.concat(stdout.length > 0 ? stdout : stderr).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new LarkCliError('malformed_json', { exitCode });
    }

    if (command.id === 'auth.status' && exitCode === 0) {
      const authStatus = authStatusSchema.safeParse(parsed);
      if (!authStatus.success) throw new LarkCliError('invalid_envelope', { exitCode });
      return authStatus.data as T;
    }

    const envelope = larkEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) throw new LarkCliError('invalid_envelope', { exitCode });
    if (!envelope.data.ok) throw LarkCliError.fromEnvelope(envelope.data.error, exitCode);
    if (exitCode !== 0) throw new LarkCliError('cli_error', { exitCode });
    return envelope.data.data as T;
  }

  private recordExecution(metadata: LarkExecutionMetadata) {
    try {
      this.options.onExecution?.(metadata);
    } catch {
      // Observability must never change command behavior.
    }
  }
}
