import { describe, expect, it, vi } from 'vitest';
import {
  isValidSemVer,
  runReleaseValidation,
  validateRelease,
} from '../../scripts/validate-release.js';

const ghcrImage = 'ghcr.io/plutoless/minori';
const commitSha = 'a'.repeat(40);

describe('isValidSemVer', () => {
  it.each([
    '0.1.1',
    '0.0.0',
    '1.2.3',
    '10.20.30',
    '1.2.3-0',
    '1.2.3-alpha',
    '1.2.3-alpha.1',
    '1.2.3-alpha-1.001x',
    '1.2.3+build.001',
    '1.2.3-rc.1+build.5',
  ])('accepts valid SemVer 2.0 version %s', (version) => {
    expect(isValidSemVer(version)).toBe(true);
  });

  it.each([
    'not-semver',
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha.01',
    '1.2.3-',
    '1.2.3-alpha..1',
    '1.2.3+',
    '1.2.3+build..1',
    ' 1.2.3',
    '1.2.3 ',
    '1.2.3/rc',
    'v1.2.3',
  ])('rejects invalid SemVer 2.0 version %s', (version) => {
    expect(isValidSemVer(version)).toBe(false);
  });
});

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
    ['a normal version', '1.2.3'],
    ['a prerelease version', '10.20.30-rc.1'],
  ])('accepts %s when the exact tag remains a valid Docker tag', (_label, version) => {
    expect(validateRelease({
      refName: `v${version}`,
      sha: commitSha,
      packageVersion: version,
      ghcrImage,
      isOnMain: true,
    }).version).toBe(version);
  });

  it('rejects valid SemVer build metadata because its plus sign cannot be an exact Docker tag', () => {
    const version = '1.2.3+build.5';
    expect(isValidSemVer(version)).toBe(true);
    expect(() => validateRelease({
      refName: `v${version}`,
      sha: commitSha,
      packageVersion: version,
      ghcrImage,
      isOnMain: true,
    })).toThrow('release_package_version_invalid');
  });

  it.each([
    ['a tag without v', { refName: '0.1.1' }, 'release_tag_version_mismatch'],
    ['prerelease text absent from package version', { refName: 'v0.1.1-rc.1' }, 'release_tag_version_mismatch'],
    ['an uppercase SHA', { sha: 'A'.repeat(40) }, 'release_sha_invalid'],
    ['a malformed SHA', { sha: 'a'.repeat(39) }, 'release_sha_invalid'],
    ['a different image repository', { ghcrImage: 'ghcr.io/other/minori' }, 'release_ghcr_image_invalid'],
    ['a tag that does not match package version', { refName: 'v0.1.2' }, 'release_tag_version_mismatch'],
    ['a commit outside main', { isOnMain: false }, 'release_commit_not_on_main'],
    ['an invalid package version before tag equality', { refName: 'vnot-semver', packageVersion: 'not-semver' }, 'release_package_version_invalid'],
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
        GITHUB_REF_NAME: 'v0.2.3',
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
      version: '0.2.3',
      semverTag: 'v0.2.3',
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
        GITHUB_REF_NAME: 'v0.1.0',
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
