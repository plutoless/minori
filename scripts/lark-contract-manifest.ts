import { createHash } from 'node:crypto';
import {
  lstat, readFile, realpath, rename, rm,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { scanForbiddenResidue } from './lark-contract-sanitizer.js';

export const FIXTURE_MODES = ['envelope_only', 'envelope_data'] as const;
export const AUDIT_STATES = [
  'verified', 'needs_review', 'unavailable', 'not_exercised_by_policy', 'failed',
] as const;

export type FixtureMode = typeof FIXTURE_MODES[number];
export type AuditState = typeof AUDIT_STATES[number];

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const relativeFileSchema = z.string().min(1).refine((value) => (
  !isAbsolute(value)
  && !value.split(/[\\/]/u).includes('..')
  && value !== '.'
), 'unsafe_fixture_path');

const caseSchema = z.object({
  caseId: z.string().min(1),
  commandVariant: z.string().min(1),
  structuralCase: z.string().min(1).optional(),
  fixtureMode: z.enum(FIXTURE_MODES),
  envelopePath: relativeFileSchema.optional(),
  envelopeSha256: digestSchema.optional(),
  dataPath: relativeFileSchema.optional(),
  dataSha256: digestSchema.optional(),
  owningTest: relativeFileSchema.optional(),
  operationCategory: z.string().min(1),
  state: z.enum(AUDIT_STATES),
  stage: z.string().min(1).optional(),
  unclassifiedStringFields: z.array(z.string().min(1)),
}).superRefine((entry, context) => {
  if (entry.fixtureMode === 'envelope_only' && entry.commandVariant !== 'auth.status') {
    context.addIssue({ code: 'custom', message: 'envelope_only_reserved_for_auth' });
  }
  if (entry.state === 'verified') {
    if (!entry.envelopePath || !entry.envelopeSha256) {
      context.addIssue({ code: 'custom', message: 'verified_envelope_required' });
    }
    if (entry.unclassifiedStringFields.length > 0) {
      context.addIssue({ code: 'custom', message: 'verified_strings_must_be_classified' });
    }
    if (entry.fixtureMode === 'envelope_data') {
      if (!entry.dataPath || !entry.dataSha256 || !entry.owningTest) {
        context.addIssue({ code: 'custom', message: 'verified_data_required' });
      }
    } else if (entry.dataPath || entry.dataSha256 || entry.owningTest) {
      context.addIssue({ code: 'custom', message: 'envelope_only_has_no_data' });
    }
  } else if (
    entry.envelopePath || entry.envelopeSha256 || entry.dataPath || entry.dataSha256
    || entry.owningTest
  ) {
    context.addIssue({ code: 'custom', message: 'unverified_case_has_no_fixture' });
  }
});

const manifestSchema = z.object({
  cliVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
  capturedAt: z.string().datetime(),
  cases: z.array(caseSchema).min(1),
}).superRefine((manifest, context) => {
  const seen = new Set<string>();
  for (const entry of manifest.cases) {
    if (seen.has(entry.caseId)) {
      context.addIssue({ code: 'custom', message: `duplicate_case:${entry.caseId}` });
    }
    seen.add(entry.caseId);
  }
});

export type LarkContractManifest = z.output<typeof manifestSchema>;

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sorted(child)]));
  }
  return value;
}

export function canonicalJson(value: unknown) {
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}

export async function sha256File(path: string) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function loadContractManifest(path: string): Promise<LarkContractManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('lark_contract_manifest_invalid');
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error('lark_contract_manifest_invalid');
  return parsed.data;
}

async function containedRegularFile(root: string, path: string) {
  const rootReal = await realpath(root);
  const candidate = resolve(rootReal, path);
  const candidateRelative = relative(rootReal, candidate);
  if (candidateRelative.startsWith('..') || isAbsolute(candidateRelative)) {
    throw new Error('lark_contract_fixture_invalid');
  }
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('lark_contract_fixture_invalid');
  const candidateReal = await realpath(candidate);
  const realRelative = relative(rootReal, candidateReal);
  if (realRelative.startsWith('..') || isAbsolute(realRelative)) {
    throw new Error('lark_contract_fixture_invalid');
  }
  return candidate;
}

async function lockfileVersion(path: string) {
  try {
    const lock = JSON.parse(await readFile(path, 'utf8')) as {
      packages?: Record<string, { version?: unknown }>;
    };
    const version = lock.packages?.['node_modules/@larksuite/cli']?.version;
    if (typeof version !== 'string') throw new Error();
    return version;
  } catch {
    throw new Error('lark_contract_version_mismatch');
  }
}

export async function verifyFixtureSet(input: {
  manifestPath: string;
  fixtureRoot: string;
  lockfilePath: string;
}) {
  const manifest = await loadContractManifest(input.manifestPath);
  const directoryVersion = basename(input.fixtureRoot).match(/^cli-(\d+\.\d+\.\d+)$/u)?.[1];
  const resolvedVersion = await lockfileVersion(input.lockfilePath);
  if (!directoryVersion || manifest.cliVersion !== directoryVersion
    || manifest.cliVersion !== resolvedVersion) {
    throw new Error('lark_contract_version_mismatch');
  }

  const generatedFiles: string[] = [];
  for (const entry of manifest.cases) {
    if (entry.state !== 'verified') continue;
    try {
      const envelopePath = await containedRegularFile(input.fixtureRoot, entry.envelopePath!);
      generatedFiles.push(envelopePath);
      if (await sha256File(envelopePath) !== entry.envelopeSha256) throw new Error();
      const envelopeRaw = await readFile(envelopePath, 'utf8');
      const envelope = JSON.parse(envelopeRaw) as unknown;
      if (canonicalJson(envelope) !== envelopeRaw) throw new Error();
      if (entry.fixtureMode === 'envelope_data') {
        const dataPath = await containedRegularFile(input.fixtureRoot, entry.dataPath!);
        generatedFiles.push(dataPath);
        if (await sha256File(dataPath) !== entry.dataSha256) throw new Error();
        const dataRaw = await readFile(dataPath, 'utf8');
        const data = JSON.parse(dataRaw) as unknown;
        if (canonicalJson(data) !== dataRaw) throw new Error();
        if (canonicalJson((envelope as { data?: unknown }).data) !== dataRaw) throw new Error();
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'lark_contract_fixture_invalid') throw error;
      throw new Error('lark_contract_fixture_invalid');
    }
  }
  await scanForbiddenResidue(generatedFiles);
}

export async function installFixtureSetAtomically(input: {
  stagedRoot: string;
  targetRoot: string;
  lockfilePath: string;
}) {
  await verifyFixtureSet({
    manifestPath: join(input.stagedRoot, 'manifest.json'),
    fixtureRoot: input.stagedRoot,
    lockfilePath: input.lockfilePath,
  });
  const backup = join(dirname(input.targetRoot), `.${basename(input.targetRoot)}.backup`);
  await rm(backup, { recursive: true, force: true });
  let movedOld = false;
  try {
    try {
      await rename(input.targetRoot, backup);
      movedOld = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(input.stagedRoot, input.targetRoot);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedOld) {
      await rm(input.targetRoot, { recursive: true, force: true });
      await rename(backup, input.targetRoot);
    }
    throw error;
  }
}
