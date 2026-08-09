import { execFile } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const expectedGhcrImage = 'ghcr.io/plutoless/minori';
const commitShaPattern = /^[0-9a-f]{40}$/u;

export type ReleaseInput = {
  refName: string;
  sha: string;
  packageVersion: string;
  ghcrImage: string;
  isOnMain: boolean;
};

export type ReleaseOutput = {
  commitSha: string;
  version: string;
  semverTag: string;
  ghcrImage: string;
};

export type ReleaseValidationDependencies = {
  environment?: Readonly<Record<string, string | undefined>>;
  isAncestor?: (commitSha: string) => Promise<boolean>;
  writeOutput?: (output: ReleaseOutput) => void;
  reportFailure?: (category: string) => void;
};

class ReleaseValidationError extends Error {
  constructor(category: string) {
    super(category);
    this.name = 'ReleaseValidationError';
  }
}

export function validateRelease(input: ReleaseInput): ReleaseOutput {
  if (input.refName !== `v${input.packageVersion}`) {
    throw new ReleaseValidationError('release_tag_version_mismatch');
  }
  if (!commitShaPattern.test(input.sha)) {
    throw new ReleaseValidationError('release_sha_invalid');
  }
  if (input.ghcrImage !== expectedGhcrImage) {
    throw new ReleaseValidationError('release_ghcr_image_invalid');
  }
  if (!input.isOnMain) {
    throw new ReleaseValidationError('release_commit_not_on_main');
  }

  return {
    commitSha: input.sha,
    version: input.packageVersion,
    semverTag: input.refName,
    ghcrImage: input.ghcrImage,
  };
}

function readPackageVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
      throw new Error('invalid package version');
    }
    return packageJson.version;
  } catch {
    throw new ReleaseValidationError('release_package_version_invalid');
  }
}

function checkAncestry(commitSha: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['merge-base', '--is-ancestor', commitSha, 'origin/main'],
      { shell: false },
      (error) => resolve(error === null),
    );
  });
}

function appendGitHubOutput(output: ReleaseOutput, outputPath: string | undefined): void {
  if (!outputPath) throw new ReleaseValidationError('release_output_unavailable');

  appendFileSync(
    outputPath,
    `${Object.entries(output).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    'utf8',
  );
}

export async function runReleaseValidation(
  dependencies: ReleaseValidationDependencies = {},
): Promise<0 | 1> {
  const environment = dependencies.environment ?? process.env;
  const reportFailure = dependencies.reportFailure ?? ((category: string) => console.error(category));

  try {
    if (environment.GITHUB_REF_TYPE !== 'tag') {
      throw new ReleaseValidationError('release_ref_type_invalid');
    }

    const packageVersion = readPackageVersion();
    const commitSha = environment.GITHUB_SHA ?? '';
    const input = {
      refName: environment.GITHUB_REF_NAME ?? '',
      sha: commitSha,
      packageVersion,
      ghcrImage: environment.GHCR_IMAGE ?? '',
    };
    validateRelease({ ...input, isOnMain: true });
    const isOnMain = await (dependencies.isAncestor ?? checkAncestry)(commitSha);
    const output = validateRelease({ ...input, isOnMain });

    if (dependencies.writeOutput) dependencies.writeOutput(output);
    else appendGitHubOutput(output, environment.GITHUB_OUTPUT);
    return 0;
  } catch (error) {
    reportFailure(error instanceof ReleaseValidationError
      ? error.message
      : 'release_validation_failed');
    return 1;
  }
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const exitCode = await runReleaseValidation();
  process.exitCode = exitCode;
}
