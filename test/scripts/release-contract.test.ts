import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function text(path: string) {
  return readFile(path, 'utf8');
}

describe('Team Agent release packaging contract', () => {
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

  it('documents the exact Bot Authority required for Live Group History', async () => {
    const readme = await text('README.md');

    expect(readme).toContain('im:message.group_msg');
    expect(readme).toContain('im:chat.members:read');
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

  it('passes the fixed production env file through deploy and rollback Compose calls', async () => {
    const deploy = await text('scripts/deploy-vultr.sh');
    const rollback = await text('scripts/rollback-vultr.sh');

    expect(deploy).toContain('MINORI_ENV_FILE="$env_file"');
    expect(deploy.match(/MINORI_ENV_FILE=/gu)).toHaveLength(4);
    expect(deploy).not.toContain('--env LARKSUITE_CLI_CONFIG_DIR=');
    expect(deploy).not.toContain('--env LARKSUITE_CLI_DATA_DIR=');
    expect(rollback).toContain('env_file="/opt/minori/minori.env"');
    expect(rollback.match(/MINORI_ENV_FILE=/gu)).toHaveLength(2);
  });

  it('labels the deployed image with the exact release commit', async () => {
    const deploy = await text('scripts/deploy-vultr.sh');

    expect(deploy).toContain('--label "org.opencontainers.image.revision=$commit_sha"');
  });

  it('documents exact-commit build, then OAuth, then deployment', async () => {
    const readme = await text('README.md');
    const plan = await text('docs/superpowers/plans/2026-08-07-team-agent.md');
    const build = readme.indexOf('git archive "$COMMIT_SHA" | docker build');
    const oauth = readme.indexOf('"minori:${COMMIT_SHA}" npm run lark:auth');
    const deploy = readme.indexOf('./scripts/deploy-vultr.sh "$COMMIT_SHA"');

    expect(build).toBeGreaterThan(-1);
    expect(oauth).toBeGreaterThan(build);
    expect(deploy).toBeGreaterThan(oauth);
    expect(plan).toContain('MINORI_ENV_FILE=./env.example');
    expect(plan).toContain('Build the exact commit, bootstrap OAuth, and only then deploy');
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
});
