import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const releaseContractTestImage = 'minori:release-contract-test';

async function text(path: string) {
  return readFile(path, 'utf8');
}

describe('Team Agent release packaging contract', () => {
  it('keeps the workflow handoff aligned with the forced-command v1 grammar', async () => {
    const workflow = await text('.github/workflows/release.yml');
    const entrypoint = await text('deploy/vultr/ci-deploy');

    expect(workflow).toContain(
      'remote_command="deploy v1 ${COMMIT_SHA} ${GHCR_IMAGE}@${BUILD_DIGEST}"',
    );
    expect(entrypoint).toContain(
      "command_pattern='^deploy v1 ([0123456789abcdef]{40}) (ghcr\\.io/plutoless/minori@sha256:[0123456789abcdef]{64})$'",
    );
  });

  it('keeps production Compose strict and leaves Agent limits to the env file', async () => {
    const compose = await text('deploy/vultr/compose.production.yaml');

    expect(compose).toContain('image: ${MINORI_IMAGE:?MINORI_IMAGE is required}');
    expect(compose).toContain('${MINORI_ENV_FILE:?MINORI_ENV_FILE is required}');
    expect(compose).not.toContain('required: false');
    expect(compose).not.toContain('AGENT_MAX_STEPS:');
    expect(compose).not.toContain('AGENT_TIMEOUT_MS:');
    expect(compose).not.toContain('LARKSUITE_CLI_CONFIG_DIR:');
    expect(compose).not.toContain('LARKSUITE_CLI_DATA_DIR:');
  });

  it('keeps the obsolete chat allowlist out of release configuration and guidance', async () => {
    const localEnvironment = await text('.env.example');
    const productionEnvironment = await text('deploy/vultr/env.example');
    const readme = await text('README.md');

    expect(localEnvironment).not.toContain('ALLOWED_CHAT_IDS');
    expect(productionEnvironment).not.toContain('ALLOWED_CHAT_IDS');
    expect(readme).not.toContain('ALLOWED_CHAT_IDS');
  });

  it('publishes the production Agent execution defaults in both environment examples', async () => {
    const localEnvironment = await text('.env.example');
    const productionEnvironment = await text('deploy/vultr/env.example');

    expect(localEnvironment).toContain('AGENT_MAX_STEPS=40');
    expect(localEnvironment).toContain('AGENT_TIMEOUT_MS=300000');
    expect(productionEnvironment).toContain('AGENT_MAX_STEPS=40');
    expect(productionEnvironment).toContain('AGENT_TIMEOUT_MS=300000');
  });

  it('publishes one bounded Team Context configuration in both environment examples', async () => {
    const localEnvironment = await text('.env.example');
    const productionEnvironment = await text('deploy/vultr/env.example');

    for (const environment of [localEnvironment, productionEnvironment]) {
      expect(environment).toContain('TEAM_CONTEXT_DOCUMENT_TOKEN=dox_team_context');
      expect(environment).toContain('TEAM_CONTEXT_TOKEN_BUDGET=8000');
      expect(environment).toContain('TEAM_CONTEXT_STALE_MAX_MS=86400000');
    }
  });

  it('publishes safe scheduler defaults and keeps production disabled-first', async () => {
    const localEnvironment = await readFile('.env.example', 'utf8');
    const productionEnvironment = await readFile('deploy/vultr/env.example', 'utf8');
    for (const environment of [localEnvironment, productionEnvironment]) {
      expect(environment).toContain('SCHEDULE_DEFAULT_TIMEZONE=Asia/Shanghai');
      expect(environment).toContain('SCHEDULE_POLL_MS=15000');
      expect(environment).toContain('SCHEDULE_LEASE_MS=420000');
    }
    expect(localEnvironment).toContain('SCHEDULE_ENABLED=true');
    expect(productionEnvironment).toContain('SCHEDULE_ENABLED=false');
    const app = await text('src/app.ts');
    expect(app).toContain('if (config.scheduleEnabled && storage.scheduleStore && storage.scheduledRunStore)');
  });

  it('documents the exact Bot Authority required for Live Group History', async () => {
    const readme = await text('README.md');

    expect(readme).toContain('im:message.group_msg');
    expect(readme).toContain('im:chat.members:read');
    expect(readme).toContain('im:chat:read');
  });

  it('keeps active product guidance on ordinary replies and Group Context', async () => {
    const readme = await text('README.md');
    const activeDesign = await text(
      'docs/superpowers/specs/2026-08-07-team-agent-design.md',
    );

    for (const guidance of [readme, activeDesign]) {
      expect(guidance).toMatch(/ordinary (?:private and group )?replies/u);
      expect(guidance).toContain('topic-mode groups');
      expect(guidance).toContain('Group Context');
      expect(guidance).toContain('Live Group History');
      expect(guidance).not.toMatch(
        /Agent Threads?|known Agent Thread|(?:supports?|creates?|sends?) (?:topic|thread) replies|does not provide Live Group History/iu,
      );
    }
  });

  it('keeps active acceptance guidance on the exact sanitized evidence whitelist', async () => {
    const readme = await text('README.md');
    const activeDesign = await text(
      'docs/superpowers/specs/2026-08-07-team-agent-design.md',
    );

    for (const guidance of [readme, activeDesign]) {
      expect(guidance).toContain(
        'Records may contain only the check name, exact full commit and image, trigger/reply IDs for invoked messages, cutoff timestamp, history status/count/page count, readiness category, timestamp, and pass/fail result.',
      );
      expect(guidance).toContain(
        'Never record group-history bodies, member names, Open IDs, prompts, provider output, OAuth data, environment values, credentials, or document contents.',
      );
    }

    const activeDesignEvidence = activeDesign.slice(
      activeDesign.indexOf('- Acceptance evidence is local and gitignored.'),
      activeDesign.indexOf('## Deferred scope'),
    );
    expect(activeDesignEvidence).not.toMatch(/\bURLs?\b/u);
  });

  it('retires the legacy manual deploy and rollback entrypoints', async () => {
    const deploy = await text('scripts/deploy-vultr.sh');
    const rollback = await text('scripts/rollback-vultr.sh');

    for (const retired of [deploy, rollback]) {
      expect(retired).toContain('/opt/minori/bin/rehearse-release');
      expect(retired).toContain('exit 2');
      expect(retired).not.toContain('docker ');
      expect(retired).not.toContain('git worktree');
    }
    expect(deploy).toContain('approved GitHub production release');
    expect(rollback).toContain('no second operational deployment protocol');
    const dockerignore = await text('.dockerignore');
    expect(dockerignore).toContain('scripts/deploy-vultr.sh');
    expect(dockerignore).toContain('scripts/rollback-vultr.sh');
  });

  it('binds the consumed rehearsal receipt to the exact accepted transition', async () => {
    const receipt = await text('deploy/vultr/rehearsal-v0.1.1.accepted');
    expect(receipt).toBe(
      'v1\t88cfe2bd0cde870e1c77ea71b035f7c1c2b1b599\tghcr.io/plutoless/minori@sha256:b9fbe52a854c18578bbfeb989ed39b2955aafe46dcb230e7567f8228b9754bbb\tcea9107ab9bc2f85635a2f999dc834fafb8e5a82\tminori:cea9107ab9bc2f85635a2f999dc834fafb8e5a82\n',
    );
  });

  it('installs one restricted forced command without replacing unrelated authorized keys', async () => {
    const installer = await text('deploy/vultr/install-ci-deploy.sh');
    const entrypoint = await text('deploy/vultr/ci-deploy');

    expect(installer).toContain('forced_command="${bin_dir}/ci-deploy"');
    expect(installer).toContain('forced_prefix="restrict,command=\\\"${forced_command}\\\""');
    expect(installer).toContain(
      "permituserenvironment\" { print $2 }' <<< \"$effective_before\" | paste -sd ' ' -)\" != no",
    );
    expect(installer).toContain("\"$accepted_environment\" != 'LANG LC_*'");
    expect(installer).toContain("\"$fixed_environment\" != 'BASH_ENV=/dev/null ENV=/dev/null'");
    expect(installer).toContain('/usr/bin/systemctl reload ssh.service');
    expect(installer).toContain('ambiguous_deployment_key');
    expect(installer).toContain('replace_authorized_keys remove');
    expect(installer).toContain('replace_authorized_keys add');
    expect(installer).toContain('stat -c \'%u %g %a\'');
    expect(installer).toContain('(8#$mode & 8#022) == 0');
    expect(installer).toContain('clean-entrypoint.py');
    expect(installer).toContain('libexec_dir="${install_root}/libexec"');
    expect(installer).toContain('install_file 0700 "${script_dir}/ci-deploy" "${libexec_dir}/ci-deploy"');
    expect(entrypoint).toContain("installed_entrypoint='/opt/minori/libexec/ci-deploy'");
    expect(entrypoint).toContain("minori_root='/opt/minori'");
    expect(entrypoint).toContain("lock_file='/run/lock/minori-ci-deploy.lock'");
    expect(entrypoint).toContain('release_command=(/opt/minori/bin/minori-release)');
  });

  it('declares the exact scheduled-tasks release version in both package manifests', async () => {
    const manifest = JSON.parse(await text('package.json')) as { version: string };
    const lockfile = JSON.parse(await text('package-lock.json')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };

    expect(manifest.version).toBe('0.2.0');
    expect(lockfile.version).toBe('0.2.0');
    expect(lockfile.packages[''].version).toBe('0.2.0');
  });

  it('documents the GitHub-only release operator paths without a legacy deploy command', async () => {
    const readme = await text('README.md');
    const bootstrap = readme.indexOf('Public-package bootstrap');
    const release = readme.indexOf('Release Intent and Production Approval');
    const diagnosis = readme.indexOf('Failure-category diagnosis');
    const rehearsal = readme.indexOf('One-time transition rehearsal');

    expect(bootstrap).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(bootstrap);
    expect(diagnosis).toBeGreaterThan(release);
    expect(rehearsal).toBeGreaterThan(diagnosis);
    expect(readme).toContain('create and push `v0.1.1` from `main`');
    expect(readme).toContain('GitHub `production` Environment');
    expect(readme).toContain('changes the new GHCR package to **Public** exactly once');
    expect(readme).toContain('anonymous digest pull');
    expect(readme).toContain('only then grants Production Approval');
    expect(readme).toContain('immutable digest');
    expect(readme).toContain('current healthy image plus its two most recent verified healthy predecessors');
    expect(readme).toContain('GitHub Deployment status, Actions result/email, job summary, and sanitized server release record');
    expect(readme).toContain('same person may create the tag and grant Production Approval');
    expect(readme).toContain('Prevent self-review is disabled');
    expect(readme).toContain('two-step confirmation, not two-person separation');
    expect(readme).toContain('current healthy release stays running');
    expect(readme).toContain('diagnosis, not a manual or emergency deploy path');
    expect(readme).toContain('`v0.1.1` -> `v0.1.0` -> the same `v0.1.1` digest');
    expect(readme).toContain('root-only durable receipt disables any repeat');
    expect(readme).toContain('do not run the rehearsal again');
    expect(readme).not.toContain('./scripts/deploy-vultr.sh');
    expect(readme).not.toContain('./scripts/rollback-vultr.sh');
  });

  it('keeps active delivery guidance on the literal Deployment Protocol v1 terms', async () => {
    const readme = await text('README.md');
    const context = await text('CONTEXT.md');
    const design = await text('docs/superpowers/specs/2026-08-09-github-actions-ci-cd-design.md');
    const adr = await text('docs/adr/0014-deliver-releases-by-approved-ghcr-digest.md');
    const workflow = await text('.github/workflows/release.yml');

    for (const guidance of [readme, context, design, adr]) {
      expect(guidance).toContain('Deployment Protocol `v1`');
      expect(guidance).toContain('immutable digest');
    }
    expect(workflow).toContain('deploy v1 ${COMMIT_SHA} ${GHCR_IMAGE}@${BUILD_DIGEST}');
  });

  it('keeps candidate migrations compatible with the fixed-point rollback image', async () => {
    const migration = await text('drizzle/0002_open_admission.sql');
    const schema = await text('src/storage/schema.ts');
    const readme = await text('README.md');

    expect(migration).not.toMatch(/drop\s+table\s+"?allowed_chats/iu);
    expect(migration).toContain('rollback floor advances beyond 4f936ab');
    expect(schema).toContain("rollbackCompatibilityAdmission = pgTable('allowed_chats'");
    expect(readme).toContain('rollback does not downgrade the database');
    expect(readme).toContain('current runtime never reads or writes that table');
  });

  it('installs runtime CA trust and persists the Lark CLI home', async () => {
    const dockerfile = await text('Dockerfile');
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:22-bookworm-slim AS runtime'));

    expect(runtime).toContain('apt-get install --yes --no-install-recommends ca-certificates');
    expect(runtime).toContain('HOME=/var/lib/minori/lark/home');
    expect(runtime).toContain('mkdir -p /var/lib/minori/lark/home');
    expect(runtime).toContain('chown -R 10001:10001 /app /var/lib/minori/lark /tmp/minori');
    expect(runtime).not.toContain('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('embeds the exact immutable deployment contract at fixed runtime paths', async () => {
    const dockerfile = await text('Dockerfile');
    const protocol = await text('deploy/vultr/deployment-protocol');
    const runtime = dockerfile.slice(dockerfile.indexOf('FROM node:22-bookworm-slim AS runtime'));

    expect(protocol).toBe('v1\n');
    expect(runtime).toContain(
      'COPY --chown=minori:minori deploy/vultr/compose.production.yaml /opt/minori/release/compose.production.yaml',
    );
    expect(runtime).toContain(
      'COPY --chown=minori:minori deploy/vultr/deployment-protocol /opt/minori/release/deployment-protocol',
    );
  });

  it('keeps embedded release contracts immutable to the runtime user', async () => {
    await execFileAsync('docker', [
      'build', '--platform', 'linux/amd64', '-t', releaseContractTestImage, '.',
    ]);
    await execFileAsync('docker', [
      'run', '--rm', '--user', '10001:10001', '--entrypoint', 'sh', releaseContractTestImage,
      '-c', [
        'test "$(stat -c %u:%g:%a /opt/minori/release/compose.production.yaml)" = 0:0:444',
        'test "$(stat -c %u:%g:%a /opt/minori/release/deployment-protocol)" = 0:0:444',
        'if (printf invalid > /opt/minori/release/compose.production.yaml) 2>/dev/null; then exit 1; fi',
        'if (printf invalid > /opt/minori/release/deployment-protocol) 2>/dev/null; then exit 1; fi',
        'if rm /opt/minori/release/compose.production.yaml 2>/dev/null; then exit 1; fi',
        'if rm /opt/minori/release/deployment-protocol 2>/dev/null; then exit 1; fi',
        'test ! -e /app/scripts/deploy-vultr.sh',
        'test ! -e /app/scripts/rollback-vultr.sh',
      ].join(' && '),
    ]);
  }, 600_000);
});
