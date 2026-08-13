import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  loadContractManifest,
  sha256File,
} from '../../scripts/lark-contract-manifest.js';

const DEFAULT_FIXTURE_ROOT = resolve('test/fixtures/lark/cli-1.0.84');

async function entryFor(caseId: string, fixtureRoot: string) {
  const manifest = await loadContractManifest(resolve(fixtureRoot, 'manifest.json'));
  const entry = manifest.cases.find((candidate) => candidate.caseId === caseId);
  if (!entry || entry.state !== 'verified') throw new Error('lark_contract_fixture_unavailable');
  return entry;
}

async function loadVerifiedJson(path: string, expectedDigest: string) {
  if (await sha256File(path) !== expectedDigest) throw new Error('lark_contract_fixture_invalid');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function loadFixtureEnvelope(
  caseId: string,
  fixtureRoot = DEFAULT_FIXTURE_ROOT,
) {
  const entry = await entryFor(caseId, fixtureRoot);
  return loadVerifiedJson(
    resolve(fixtureRoot, entry.envelopePath!),
    entry.envelopeSha256!,
  );
}

export async function loadFixtureData(
  caseId: string,
  fixtureRoot = DEFAULT_FIXTURE_ROOT,
) {
  const entry = await entryFor(caseId, fixtureRoot);
  if (entry.fixtureMode !== 'envelope_data') throw new Error('lark_contract_fixture_has_no_data');
  return loadVerifiedJson(resolve(fixtureRoot, entry.dataPath!), entry.dataSha256!);
}
