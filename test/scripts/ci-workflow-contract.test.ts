import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
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
const execFileAsync = promisify(execFile);

type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: Record<string, string | boolean>;
  jobs?: Record<string, WorkflowJob>;
  version?: number;
  updates?: Array<Record<string, unknown>>;
};

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
};

type WorkflowJob = {
  uses?: string;
  with?: Record<string, string>;
  'runs-on'?: string;
  steps?: WorkflowStep[];
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

function requiredSteps(job: WorkflowJob | undefined): WorkflowStep[] {
  expect(job).toBeDefined();
  expect(job?.steps).toBeDefined();
  return job!.steps!;
}

function oneStep(
  steps: WorkflowStep[],
  predicate: (step: WorkflowStep) => boolean,
): WorkflowStep {
  const matches = steps.filter(predicate);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function hasKeyMatching(value: unknown, pattern: RegExp): boolean {
  if (Array.isArray(value)) return value.some((item) => hasKeyMatching(item, pattern));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) => pattern.test(key) || hasKeyMatching(child, pattern),
  );
}

describe('GitHub Actions quality gate contract', () => {
  it('centralizes the three validation gates in the reusable workflow', async () => {
    const qualityGate = await workflow('.github/workflows/quality-gate.yml');

    expect(Object.keys(qualityGate.on ?? {})).toEqual(['workflow_call']);
    expect(qualityGate.on?.workflow_call).toMatchObject({
      inputs: { gate: { required: true, type: 'string' } },
    });
    expect(qualityGate.permissions).toEqual({ contents: 'read' });

    const steps = requiredSteps(qualityGate.jobs?.quality);

    const gateValidation = oneStep(steps, (step) => step.name === 'Validate requested gate');
    expect(gateValidation.env).toEqual({ GATE: '${{ inputs.gate }}' });
    expect(gateValidation.run).toBe(
      'case "$GATE" in\n  verify|integration|image-amd64) ;;\n  *) echo "unsupported gate" >&2; exit 1 ;;\nesac\n',
    );
    const metacharacterGate = 'verify"; exit 0; #';
    expect(gateValidation.run).not.toContain('${{');
    expect(gateValidation.run).not.toContain(metacharacterGate);
    const hostileResult = await execFileAsync('bash', ['-c', gateValidation.run!], {
      env: { ...process.env, GATE: metacharacterGate },
    }).then(
      () => ({ exitCode: 0, stderr: '' }),
      (error: { code?: number; stderr?: string }) => ({
        exitCode: error.code,
        stderr: error.stderr ?? '',
      }),
    );
    expect(hostileResult).toEqual({ exitCode: 1, stderr: 'unsupported gate\n' });

    expect(oneStep(steps, (step) => step.uses?.startsWith('actions/checkout@'))).toMatchObject({
      uses: 'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683',
    });
    expect(oneStep(steps, (step) => step.uses?.startsWith('actions/setup-node@'))).toEqual({
      uses: 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
      with: { 'node-version': '22', cache: 'npm' },
    });
    expect(oneStep(steps, (step) => step.run === 'npm ci')).toEqual({ run: 'npm ci' });
    expect(oneStep(steps, (step) => step.run === 'npm run verify')).toEqual({
      if: "inputs.gate == 'verify'",
      run: 'npm run verify',
    });
    expect(oneStep(steps, (step) => step.run?.startsWith('git ls-files'))).toEqual({
      if: "inputs.gate == 'verify'",
      run: "git ls-files -z -- '*.sh' | xargs -0 -r -n 1 bash -n",
    });
    expect(oneStep(steps, (step) => step.run?.startsWith('go run '))).toEqual({
      if: "inputs.gate == 'verify'",
      run: `go run github.com/rhysd/actionlint/cmd/actionlint@${actionlintSha}`,
    });
    expect(oneStep(steps, (step) => step.run === 'npm run test:integration')).toEqual({
      if: "inputs.gate == 'integration'",
      run: 'npm run test:integration',
    });
    expect(oneStep(steps, (step) => step.uses?.startsWith('docker/setup-buildx-action@'))).toEqual({
      if: "inputs.gate == 'image-amd64'",
      uses: 'docker/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435',
    });
    const imageBuild = oneStep(steps, (step) =>
      step.uses?.startsWith('docker/build-push-action@'),
    );
    expect(imageBuild).toEqual({
      if: "inputs.gate == 'image-amd64'",
      uses: 'docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83',
      with: {
        context: '.',
        platforms: 'linux/amd64',
        push: false,
        labels: 'org.opencontainers.image.revision=${{ github.sha }}',
      },
    });
    expect(imageBuild.with).not.toHaveProperty('tags');
  });

  it('calls the reusable workflow for every PR and main push without duplicate commands', async () => {
    const ci = await workflow('.github/workflows/ci.yml');

    expect(ci.name).toBe('CI');
    expect(ci.on).toEqual({
      pull_request: { branches: ['main'] },
      push: { branches: ['main'] },
    });
    expect(ci.concurrency).toEqual({
      group: 'ci-${{ github.event.pull_request.number || github.ref }}',
      'cancel-in-progress': "${{ github.event_name == 'pull_request' }}",
    });
    expect(ci.permissions).toEqual({ contents: 'read' });
    expect(Object.keys(ci.jobs ?? {})).toEqual(['verify', 'integration', 'image-amd64']);

    for (const [gate, job] of Object.entries(ci.jobs ?? {})) {
      expect(job).toEqual({
        uses: './.github/workflows/quality-gate.yml',
        with: { gate },
      });
    }
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

    expect(dependabot).toEqual({
      version: 2,
      updates: [
        {
        'package-ecosystem': 'github-actions',
        directory: '/',
        schedule: { interval: 'weekly' },
        'open-pull-requests-limit': 5,
        },
      ],
    });
    expect(hasKeyMatching(dependabot, /auto-merge|automerge/u)).toBe(false);
  });
});
