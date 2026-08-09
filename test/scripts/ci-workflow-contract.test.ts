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
  id?: string;
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
  needs?: string | string[];
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  environment?: string | Record<string, string>;
  concurrency?: Record<string, string | boolean>;
  steps?: WorkflowStep[];
};

async function workflow(path: string): Promise<Workflow> {
  return parse(await readFile(path, 'utf8')) as Workflow;
}

async function ruleset(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
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
      run: `go run github.com/rhysd/actionlint/cmd/actionlint@${actionlintSha} -ignore 'unexpected key "queue" for "concurrency" section'`,
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
    const release = await workflow('.github/workflows/release.yml');
    const dependabot = await workflow('.github/dependabot.yml');

    for (const use of [...allUses(qualityGate), ...allUses(ci), ...allUses(release)]) {
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

describe('GitHub Actions release contract', () => {
  it('runs every shared gate before validating and publishing a pushed release tag', async () => {
    const release = await workflow('.github/workflows/release.yml');

    expect(release.name).toBe('Release');
    expect(release.on).toEqual({ push: { tags: ['v*'] } });
    expect(release.on).not.toHaveProperty('workflow_dispatch');
    expect(release.permissions).toEqual({});

    for (const gate of ['verify', 'integration', 'image-amd64']) {
      expect(release.jobs?.[gate]).toEqual({
        uses: './.github/workflows/quality-gate.yml',
        with: { gate },
        permissions: { contents: 'read' },
      });
    }

    const validate = release.jobs?.validate;
    expect(validate?.needs).toEqual(['verify', 'integration', 'image-amd64']);
    expect(validate?.permissions).toEqual({ contents: 'read' });
    const validationSteps = requiredSteps(validate);
    const checkout = oneStep(validationSteps, (step) =>
      step.uses?.startsWith('actions/checkout@') ?? false,
    );
    expect(checkout.uses).toBe('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683');
    expect(checkout.with).toEqual({ 'fetch-depth': 0 });
    const fetchMain = oneStep(validationSteps, (step) => step.name === 'Fetch main ancestry');
    expect(fetchMain.run).toBe('git fetch --no-tags origin main:refs/remotes/origin/main');
    const validator = oneStep(validationSteps, (step) => step.name === 'Validate release');
    expect(validator.id).toBe('release');
    expect(validator.env).toEqual({ GHCR_IMAGE: '${{ vars.GHCR_IMAGE }}' });
    expect(validator.run).toBe(
      'node --experimental-strip-types scripts/validate-release.ts',
    );
    expect(validate?.outputs).toEqual({
      commit_sha: '${{ steps.release.outputs.commitSha }}',
      version: '${{ steps.release.outputs.version }}',
      semver_tag: '${{ steps.release.outputs.semverTag }}',
      ghcr_image: '${{ steps.release.outputs.ghcrImage }}',
    });

    const publish = release.jobs?.publish;
    expect(publish?.needs).toBe('validate');
    expect(publish?.permissions).toEqual({ contents: 'read', packages: 'write' });
    expect(publish?.outputs).toEqual({ digest: '${{ steps.build.outputs.digest }}' });
    for (const [jobName, job] of Object.entries(release.jobs ?? {})) {
      if (jobName !== 'publish') expect(job.permissions).not.toHaveProperty('packages', 'write');
    }

    const publishSteps = requiredSteps(publish);
    expect(oneStep(publishSteps, (step) => step.uses?.startsWith('docker/login-action@')))
      .toEqual({
        uses: 'docker/login-action@74a5d142397b4f367a81961eba4e8cd7edddf772',
        with: {
          registry: 'ghcr.io',
          username: '${{ github.actor }}',
          password: '${{ secrets.GITHUB_TOKEN }}',
        },
      });
    const builds = publishSteps.filter((step) =>
      step.uses?.startsWith('docker/build-push-action@'),
    );
    expect(builds).toHaveLength(1);
    expect(builds[0]).toEqual({
      id: 'build',
      uses: 'docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83',
      with: {
        context: '.',
        platforms: 'linux/amd64',
        push: true,
        provenance: false,
        sbom: false,
        labels: 'org.opencontainers.image.revision=${{ needs.validate.outputs.commit_sha }}',
        tags: '${{ needs.validate.outputs.ghcr_image }}:${{ needs.validate.outputs.commit_sha }}\n${{ needs.validate.outputs.ghcr_image }}:${{ needs.validate.outputs.version }}\n',
      },
    });
    const publishSummary = oneStep(
      publishSteps,
      (step) => step.name === 'Summarize published artifact',
    );
    expect(publishSummary.env).toEqual({
      RELEASE_TAG: '${{ needs.validate.outputs.semver_tag }}',
      COMMIT_SHA: '${{ needs.validate.outputs.commit_sha }}',
      BUILD_DIGEST: '${{ steps.build.outputs.digest }}',
    });
    expect(publishSummary.run).toContain('Result: `image_published`');
  });

  it('holds the immutable digest at production approval and sends one strict SSH command', async () => {
    const release = await workflow('.github/workflows/release.yml');
    const deploy = release.jobs?.deploy;

    expect(deploy?.needs).toEqual(['validate', 'publish']);
    expect(deploy?.environment).toBe('production');
    expect(deploy?.permissions).toEqual({ contents: 'read' });
    expect(deploy?.concurrency).toEqual({
      group: 'production',
      'cancel-in-progress': false,
      queue: 'max',
    });

    const steps = requiredSteps(deploy);
    const prepare = oneStep(steps, (step) => step.name === 'Prepare SSH material');
    expect(prepare.env).toEqual({
      DEPLOY_KEY: '${{ secrets.VULTR_DEPLOY_SSH_KEY }}',
      KNOWN_HOSTS: '${{ vars.VULTR_KNOWN_HOSTS }}',
    });
    expect(prepare.run).toContain('chmod 0600 "$SSH_KEY_FILE"');
    expect(prepare.run).toContain('printf \'%s\\n\' "$KNOWN_HOSTS" > "$SSH_KNOWN_HOSTS_FILE"');

    const handoff = oneStep(steps, (step) => step.name === 'Deploy immutable digest');
    expect(handoff.env).toMatchObject({
      BUILD_DIGEST: '${{ needs.publish.outputs.digest }}',
      COMMIT_SHA: '${{ needs.validate.outputs.commit_sha }}',
      GHCR_IMAGE: '${{ needs.validate.outputs.ghcr_image }}',
      DEPLOY_HOST: '${{ vars.VULTR_HOST }}',
      DEPLOY_USER: '${{ vars.VULTR_USER }}',
    });
    expect(handoff.run).toContain("[[ \"$BUILD_DIGEST\" =~ ^sha256:[0-9a-f]{64}$ ]]");
    expect(handoff.run).toContain("[[ \"$COMMIT_SHA\" =~ ^[0-9a-f]{40}$ ]]");
    expect(handoff.run).toContain("[[ \"$DEPLOY_USER\" == 'root' ]]");
    expect(handoff.run).toContain('deploy_target="root@${DEPLOY_HOST}"');
    expect(handoff.run).toContain("'minori_deploy result=success'");
    for (const category of [
      'success',
      'rejected',
      'failed',
      'locked',
      'failed_before_replace',
      'rolled_back',
      'rollback_failed',
      'recovery_failed',
    ]) {
      expect(handoff.run).toContain(
        `'minori_deploy result=${category}') result_category='${category}' ;;`,
      );
    }
    expect(handoff.run).toContain("*) result_category='deployment_protocol_error' ;;");
    expect(handoff.run).not.toMatch(/sed .*minori_deploy|grep .*minori_deploy/u);
    expect(handoff.run).toContain(
      'remote_command="deploy v1 ${COMMIT_SHA} ${GHCR_IMAGE}@${BUILD_DIGEST}"',
    );
    expect(handoff.run?.match(/^[ \t]*ssh \\\n/gmu)).toHaveLength(1);
    expect(handoff.run).toContain('-o BatchMode=yes');
    expect(handoff.run).toContain('-F /dev/null');
    expect(handoff.run).toContain('-o IdentitiesOnly=yes');
    expect(handoff.run).toContain('-o StrictHostKeyChecking=yes');
    expect(handoff.run).toContain('-o UserKnownHostsFile="$SSH_KNOWN_HOSTS_FILE"');
    expect(handoff.run).toContain('-o GlobalKnownHostsFile=/dev/null');
    expect(handoff.run).toContain('-- "$deploy_target" "$remote_command"');
    expect(handoff.run).toContain('2>"$SSH_STDERR_FILE"');
    expect(handoff.run).not.toContain('cat "$SSH_STDERR_FILE"');
    expect(handoff.run).toContain('### Production deployment');
    expect(handoff.run).toContain('production_deployment_failed category=%s');

    const cleanup = oneStep(steps, (step) => step.name === 'Remove SSH material');
    expect(cleanup.if).toBe('always()');
    expect(cleanup.run).toContain('rm -f -- "$SSH_KEY_FILE" "$SSH_KNOWN_HOSTS_FILE"');
    expect(cleanup.run).toContain('rm -f -- "$SSH_STDOUT_FILE" "$SSH_STDERR_FILE"');
    expect(prepare.run).toContain("trap 'rm -f --");
    expect(prepare.run).toContain('trap - ERR');

    const source = await readFile('.github/workflows/release.yml', 'utf8');
    expect(source).not.toMatch(/workflow_dispatch|StrictHostKeyChecking=no|set -x|scp\b|rsync\b|git checkout|docker login.*VULTR|GHCR.*(?:TOKEN|PASSWORD).*ssh/iu);
    expect(source.match(/secrets\.VULTR_DEPLOY_SSH_KEY/gu)).toHaveLength(1);
    expect(source.match(/environment:\s*production/gu)).toHaveLength(1);
  });
});

describe('GitHub repository ruleset contracts', () => {
  it('keeps the Release Line on main behind PRs and the three observed CI contexts', async () => {
    const main = await ruleset('.github/rulesets/main.json');

    expect(main).toMatchObject({
      name: 'Release Line main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      bypass_actors: [
        { actor_id: 471561, actor_type: 'User', bypass_mode: 'pull_request' },
      ],
    });
    expect(JSON.stringify(main)).not.toMatch(/\$\{|<[^>]+>|REPLACE_ME/u);

    const rules = main.rules as Array<{ type: string; parameters?: Record<string, unknown> }>;
    expect(rules).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'pull_request',
        parameters: expect.objectContaining({
          dismiss_stale_reviews_on_push: false,
          dismissal_restriction: { enabled: false, allowed_actors: [] },
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        }),
      }),
      expect.objectContaining({
        type: 'required_status_checks',
        parameters: expect.objectContaining({
          required_status_checks: [
            { context: 'CI / verify' },
            { context: 'CI / integration' },
            { context: 'CI / image-amd64' },
          ],
        }),
      }),
    ]));
  });

  it('keeps v tags immutable with no overwrite bypass', async () => {
    const tags = await ruleset('.github/rulesets/release-tags.json');

    expect(tags).toEqual(expect.objectContaining({
      name: 'Immutable release tags',
      target: 'tag',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      bypass_actors: [],
    }));
    expect(JSON.stringify(tags)).not.toMatch(/\$\{|<[^>]+>|REPLACE_ME/u);
    const ruleTypes = (tags.rules as Array<{ type: string }>).map((rule) => rule.type);
    expect(ruleTypes).toEqual(expect.arrayContaining(['update', 'deletion']));
  });
});
