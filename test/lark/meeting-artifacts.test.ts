import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MeetingArtifactError } from '../../src/lark/errors.js';
import { LarkCliError } from '../../src/lark/errors.js';
import {
  createMeetingByteBudget,
  systemMeetingArtifactStore,
} from '../../src/lark/meeting-artifacts.js';

const roots: string[] = [];

async function testRoot() {
  const root = await mkdtemp(join(tmpdir(), 'minori-meeting-test-'));
  roots.push(root);
  return root;
}

describe('systemMeetingArtifactStore', () => {
  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('reads a regular run-owned file, accounts bytes, and cleans the directory', async () => {
    const root = await testRoot();
    const store = systemMeetingArtifactStore({ temporaryRoot: root });
    const budget = createMeetingByteBudget();
    let workDir = '';

    const content = await store.withDirectory(async (directory) => {
      workDir = directory;
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      await writeFile(join(directory, 'transcript.md'), 'hello transcript', { mode: 0o600 });
      return store.readFile(directory, 'transcript.md', budget);
    });

    expect(content).toBe('hello transcript');
    expect(budget.remaining).toBe(24 * 1024 * 1024 - Buffer.byteLength(content));
    await expect(lstat(workDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects final and nested symlinks without reading their targets', async () => {
    const root = await testRoot();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside secret');
    const store = systemMeetingArtifactStore({ temporaryRoot: root });

    await store.withDirectory(async (directory) => {
      await symlink(outside, join(directory, 'final-link'));
      await expect(store.readFile(directory, 'final-link', createMeetingByteBudget()))
        .rejects.toBeInstanceOf(MeetingArtifactError);

      const real = join(directory, 'real');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(real);
      await writeFile(join(real, 'inside.txt'), 'inside');
      await symlink(real, join(directory, 'nested-link'));
      await expect(store.readFile(
        directory, 'nested-link/inside.txt', createMeetingByteBudget(),
      )).rejects.toMatchObject({ code: 'meeting_artifact_unsafe' });
    });
    expect(await readFile(outside, 'utf8')).toBe('outside secret');
  });

  it('rejects containment escapes and files over the per-file limit', async () => {
    const root = await testRoot();
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside');
    const store = systemMeetingArtifactStore({ temporaryRoot: root });

    await store.withDirectory(async (directory) => {
      await expect(store.readFile(directory, outside, createMeetingByteBudget()))
        .rejects.toMatchObject({ code: 'meeting_artifact_unsafe' });
      const oversized = join(directory, 'oversized.txt');
      await writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1), { mode: 0o600 });
      await expect(store.readFile(directory, oversized, createMeetingByteBudget()))
        .rejects.toMatchObject({ code: 'meeting_artifact_unsafe' });
    });
  });

  it('does not expose paths when a directory is unsafe', async () => {
    const root = await testRoot();
    await chmod(root, 0o700);
    const store = systemMeetingArtifactStore({ temporaryRoot: root });
    const error = await store.readFile(root, '../private.txt', createMeetingByteBudget())
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'meeting_artifact_unsafe' });
    expect(JSON.stringify(error)).not.toContain(root);
    expect(constants.O_NOFOLLOW).toBeTypeOf('number');
  });

  it('preserves cancellation from the operation while still cleaning up', async () => {
    const root = await testRoot();
    const store = systemMeetingArtifactStore({ temporaryRoot: root });
    let workDir = '';

    await expect(store.withDirectory(async (directory) => {
      workDir = directory;
      throw new LarkCliError('aborted');
    })).rejects.toMatchObject({ code: 'aborted' });
    await expect(lstat(workDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
