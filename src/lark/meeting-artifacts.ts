import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MeetingArtifactError } from './errors.js';

export const MAX_MEETING_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_MEETING_RUN_BYTES = 24 * 1024 * 1024;

export type MeetingByteBudget = { remaining: number };

export interface MeetingArtifactStore {
  withDirectory<T>(operation: (directory: string) => Promise<T>): Promise<T>;
  readFile(
    directory: string,
    candidatePath: string,
    budget: MeetingByteBudget,
  ): Promise<string>;
}

export function createMeetingByteBudget(): MeetingByteBudget {
  return { remaining: MAX_MEETING_RUN_BYTES };
}

function isContained(root: string, candidate: string) {
  const path = relative(root, candidate);
  return path.length > 0 && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function requirePlainPath(root: string, candidate: string) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new MeetingArtifactError();
  const path = relative(root, candidate);
  if (!isContained(root, candidate)) throw new MeetingArtifactError();
  let current = root;
  for (const component of path.split(sep)) {
    if (!component || component === '.' || component === '..') throw new MeetingArtifactError();
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new MeetingArtifactError();
  }
}

export function systemMeetingArtifactStore(
  options: { temporaryRoot?: string } = {},
): MeetingArtifactStore {
  return {
    async withDirectory<T>(operation: (directory: string) => Promise<T>) {
      let directory: string | undefined;
      try {
        const root = await realpath(options.temporaryRoot ?? tmpdir());
        const rootInfo = await lstat(root);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new MeetingArtifactError();
        directory = await mkdtemp(join(root, 'minori-meeting-'));
        await chmod(directory, 0o700);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
          throw new MeetingArtifactError();
        }
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
        if (error instanceof MeetingArtifactError) throw error;
        throw new MeetingArtifactError();
      }
      try {
        return await operation(directory);
      } finally {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch {
          throw new MeetingArtifactError();
        }
      }
    },

    async readFile(directory, candidatePath, budget) {
      try {
        const root = await realpath(directory);
        if (root !== resolve(directory)) throw new MeetingArtifactError();
        const candidate = resolve(root, candidatePath);
        await requirePlainPath(root, candidate);
        const resolvedCandidate = await realpath(candidate);
        if (resolvedCandidate !== candidate || !isContained(root, resolvedCandidate)) {
          throw new MeetingArtifactError();
        }
        const before = await lstat(resolvedCandidate);
        if (!before.isFile() || before.isSymbolicLink()) throw new MeetingArtifactError();
        if (before.size > MAX_MEETING_FILE_BYTES || before.size > budget.remaining) {
          throw new MeetingArtifactError();
        }
        const handle = await open(resolvedCandidate, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
            throw new MeetingArtifactError();
          }
          if (opened.size > MAX_MEETING_FILE_BYTES || opened.size > budget.remaining) {
            throw new MeetingArtifactError();
          }
          const bytes = await handle.readFile();
          if (bytes.byteLength !== opened.size) throw new MeetingArtifactError();
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          budget.remaining -= bytes.byteLength;
          return text;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof MeetingArtifactError) throw error;
        throw new MeetingArtifactError();
      }
    },
  };
}
