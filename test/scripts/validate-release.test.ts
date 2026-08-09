import { describe, expect, it, vi } from 'vitest';
import {
  runReleaseValidation,
  validateRelease,
} from '../../scripts/validate-release.js';

const ghcrImage = 'ghcr.io/plutoless/minori';
const commitSha = 'a'.repeat(40);

describe('validateRelease', () => {
  it('returns the immutable release fields when every invariant holds', () => {
    expect(validateRelease({
      refName: 'v0.1.1',
      sha: commitSha,
      packageVersion: '0.1.1',
      ghcrImage,
      isOnMain: true,
    })).toEqual({
      commitSha,
      version: '0.1.1',
      semverTag: 'v0.1.1',
      ghcrImage,
    });
  });

  it.each([
    ['a tag without v', { refName: '0.1.1' }, 'release_tag_version_mismatch'],
    ['prerelease text absent from package version', { refName: 'v0.1.1-rc.1' }, 'release_tag_version_mismatch'],
    ['an uppercase SHA', { sha: 'A'.repeat(40) }, 'release_sha_invalid'],
    ['a malformed SHA', { sha: 'a'.repeat(39) }, 'release_sha_invalid'],
    ['a different image repository', { ghcrImage: 'ghcr.io/other/minori' }, 'release_ghcr_image_invalid'],
    ['a tag that does not match package version', { refName: 'v0.1.2' }, 'release_tag_version_mismatch'],
    ['a commit outside main', { isOnMain: false }, 'release_commit_not_on_main'],
  ])('rejects %s with a stable category', (_label, override, category) => {
    expect(() => validateRelease({
      refName: 'v0.1.1',
      sha: commitSha,
      packageVersion: '0.1.1',
      ghcrImage,
      isOnMain: true,
      ...override,
    })).toThrow(category);
  });
});

describe('runReleaseValidation', () => {
  it('rejects a non-tag ref before checking ancestry or emitting output', async () => {
    const isAncestor = vi.fn(async () => true);
    const writeOutput = vi.fn();
    const reportFailure = vi.fn();

    const exitCode = await runReleaseValidation({
      environment: {
        GITHUB_REF_TYPE: 'branch',
        GITHUB_REF_NAME: 'main',
        GITHUB_SHA: commitSha,
        GHCR_IMAGE: ghcrImage,
      },
      isAncestor,
      writeOutput,
      reportFailure,
    });

    expect(exitCode).toBe(1);
    expect(isAncestor).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith('release_ref_type_invalid');
  });

  it('checks ancestry before writing the complete sanitized output', async () => {
    const isAncestor = vi.fn(async () => true);
    const writeOutput = vi.fn();
    const reportFailure = vi.fn();

    const exitCode = await runReleaseValidation({
      environment: {
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'v0.1.0',
        GITHUB_SHA: commitSha,
        GHCR_IMAGE: ghcrImage,
      },
      isAncestor,
      writeOutput,
      reportFailure,
    });

    expect(exitCode).toBe(0);
    expect(isAncestor).toHaveBeenCalledWith(commitSha);
    expect(writeOutput).toHaveBeenCalledWith({
      commitSha,
      version: '0.1.0',
      semverTag: 'v0.1.0',
      ghcrImage,
    });
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it('does not write a partial output after a failed invariant', async () => {
    const isAncestor = vi.fn(async () => true);
    const writeOutput = vi.fn();
    const reportFailure = vi.fn();

    const exitCode = await runReleaseValidation({
      environment: {
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: 'v0.1.1',
        GITHUB_SHA: commitSha,
        GHCR_IMAGE: ghcrImage,
      },
      isAncestor,
      writeOutput,
      reportFailure,
    });

    expect(exitCode).toBe(1);
    expect(isAncestor).not.toHaveBeenCalled();
    expect(writeOutput).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith('release_tag_version_mismatch');
  });
});
