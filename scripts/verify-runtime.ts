import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';

export type RuntimeStatus = 'ok' | 'degraded' | 'unconfigured';
export type RuntimeVerifier = () => Promise<RuntimeStatus>;

export type RuntimeVerificationDependencies = {
  database: RuntimeVerifier;
  feishu: RuntimeVerifier;
  lark: RuntimeVerifier;
  model: RuntimeVerifier;
};

export async function verifyRuntime(dependencies: RuntimeVerificationDependencies) {
  const names = ['database', 'feishu', 'lark', 'model'] as const;
  const entries = await Promise.all(names.map(async (name) => {
    try {
      return [name, await dependencies[name]()] as const;
    } catch {
      return [name, 'degraded'] as const;
    }
  }));
  const components = Object.fromEntries(entries) as Record<typeof names[number], RuntimeStatus>;
  return {
    ok: Object.values(components).every((status) => status === 'ok'),
    components,
  };
}

function larkAuthStatus(binary: string, configDir: string): Promise<RuntimeStatus> {
  if (!isAbsolute(configDir)) return Promise.resolve('unconfigured');
  return new Promise((resolve) => {
    const child = spawn(binary, ['auth', 'status', '--json', '--verify'], {
      shell: false,
      env: { PATH: process.env.PATH, LANG: process.env.LANG, LARKSUITE_CLI_CONFIG_DIR: configDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size <= 1024 * 1024) chunks.push(buffer);
      else child.kill('SIGKILL');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('error', () => {
      clearTimeout(timer);
      resolve('degraded');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || size > 1024 * 1024) return resolve('degraded');
      try {
        const status = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          identity?: string;
          identities?: { user?: { available?: boolean } };
        };
        resolve(status.identity === 'user' && status.identities?.user?.available === true
          ? 'ok'
          : 'degraded');
      } catch {
        resolve('degraded');
      }
    });
  });
}

async function main() {
  const probeModule = '../dist/runtime/model-preflight.js';
  const { runOpenAIResponsesProbe } = await import(probeModule) as {
    runOpenAIResponsesProbe(
      settings: { apiKey: string; baseURL?: string; model: string },
      signal: AbortSignal,
    ): Promise<void>;
  };
  const databaseUrl = process.env.DATABASE_URL;
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.AI_MODEL ?? 'gpt-5.6-terra';
  const baseURL = process.env.OPENAI_BASE_URL;
  const pool = databaseUrl ? new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
  }) : undefined;

  try {
    const result = await verifyRuntime({
      database: async () => {
        if (!pool) return 'unconfigured';
        await pool.query('select 1');
        return 'ok';
      },
      feishu: async () => process.env.FEISHU_APP_ID
        && process.env.FEISHU_APP_SECRET
        && process.env.FEISHU_BOT_OPEN_ID
        ? 'ok'
        : 'unconfigured',
      lark: () => larkAuthStatus(
        process.env.LARK_CLI_BIN ?? 'lark-cli',
        process.env.LARKSUITE_CLI_CONFIG_DIR ?? '/var/lib/minori/lark',
      ),
      model: async () => {
        if (!apiKey) return 'unconfigured';
        await runOpenAIResponsesProbe({
          apiKey,
          ...(baseURL ? { baseURL } : {}),
          model,
        }, AbortSignal.timeout(15_000));
        return 'ok';
      },
    });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.log(JSON.stringify({ ok: false, components: { runtime: 'degraded' } }));
    process.exitCode = 1;
  });
}
