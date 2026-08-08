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
  });

  it('passes the fixed production env file through deploy and rollback Compose calls', async () => {
    const deploy = await text('scripts/deploy-vultr.sh');
    const rollback = await text('scripts/rollback-vultr.sh');

    expect(deploy).toContain('MINORI_ENV_FILE="$env_file"');
    expect(deploy.match(/MINORI_ENV_FILE=/gu)).toHaveLength(4);
    expect(rollback).toContain('env_file="/opt/minori/minori.env"');
    expect(rollback.match(/MINORI_ENV_FILE=/gu)).toHaveLength(2);
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
});
