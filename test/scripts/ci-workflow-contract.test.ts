import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const approvedActionShas = new Set([
  '11bd71901bbe5b1630ceea73d27597364c9af683',
  '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'e468171a9de216ec08956ac3ada2f0791b6bd435',
  '74a5d142397b4f367a81961eba4e8cd7edddf772',
  '263435318d21b8e681c14492fe198d362a7d2c83',
]);
const actionlintSha = '03d0035246f3e81f36aed592ffb4bebf33a03106';

type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, string | boolean>;
  jobs?: Record<string, Record<string, unknown>>;
};

async function workflow(path: string): Promise<Workflow> {
  return parse(await readFile(path, 'utf8')) as Workflow;
}

function allUses(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allUses);
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) =>
      key === 'uses' && typeof child === 'string' ? [child] : allUses(child),
    );
  }
  return [];
}

describe('GitHub Actions quality gate contract', () => {
  it('centralizes the three validation gates in the reusable workflow', async () => {
    const qualityGate = await workflow('.github/workflows/quality-gate.yml');

    expect(Object.keys(qualityGate.on ?? {})).toEqual(['workflow_call']);
    expect(qualityGate.on?.workflow_call).toMatchObject({
      inputs: { gate: { required: true, type: 'string' } },
    });
    expect(qualityGate.permissions).toEqual({ contents: 'read' });

    const job = qualityGate.jobs?.quality;
    expect(job).toBeDefined();
    const commands = JSON.stringify(job);
    expect(commands).toContain('npm run verify');
    expect(commands).toContain('npm run test:integration');
    expect(commands).toContain('docker/build-push-action');
    expect(commands).toContain('git ls-files');
    expect(commands).toContain('*.sh');
    expect(commands).toContain('bash -n');
    expect(commands).toContain(`github.com/rhysd/actionlint/cmd/actionlint@${actionlintSha}`);
    expect(commands).toContain('linux/amd64');
    expect(commands).toContain('org.opencontainers.image.revision=${{ github.sha }}');
    expect(commands).toContain("verify|integration|image-amd64");
  });

  it('calls the reusable workflow for every PR and main push without duplicate commands', async () => {
    const ci = await workflow('.github/workflows/ci.yml');

    expect(ci.name).toBe('CI');
    expect(ci.on).toEqual({
      pull_request: { branches: ['main'] },
      push: { branches: ['main'] },
    });
    expect(JSON.stringify(ci.on)).not.toMatch(/paths(?:-ignore)?/u);
    expect(ci.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(ci.jobs ?? {})).toEqual(['verify', 'integration', 'image-amd64']);

    for (const [gate, job] of Object.entries(ci.jobs ?? {})) {
      expect(job).toMatchObject({
        uses: './.github/workflows/quality-gate.yml',
        with: { gate },
      });
    }

    const callerContent = JSON.stringify(ci.jobs);
    expect(callerContent).not.toContain('npm run verify');
    expect(callerContent).not.toContain('npm run test:integration');
    expect(callerContent).not.toContain('docker build');
  });

  it('pins approved Actions and keeps Dependabot narrow and manual', async () => {
    const qualityGate = await workflow('.github/workflows/quality-gate.yml');
    const ci = await workflow('.github/workflows/ci.yml');
    const dependabot = await workflow('.github/dependabot.yml');

    for (const use of [...allUses(qualityGate), ...allUses(ci)]) {
      if (use.startsWith('./')) continue;
      const sha = use.split('@')[1];
      expect(sha).toMatch(/^[0-9a-f]{40}$/u);
      expect(approvedActionShas).toContain(sha);
    }

    expect(dependabot.version).toBe(2);
    expect(dependabot.updates).toEqual([
      expect.objectContaining({
        'package-ecosystem': 'github-actions',
        directory: '/',
        schedule: { interval: 'weekly' },
        'open-pull-requests-limit': expect.any(Number),
      }),
    ]);
    expect(JSON.stringify(dependabot)).not.toMatch(/auto-merge|automerge/u);
  });
});
