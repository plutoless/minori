import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  installFixtureSetAtomically,
  verifyFixtureSet,
} from '../../scripts/lark-contract-manifest.js';
import {
  loadFixtureData,
  loadFixtureEnvelope,
} from '../helpers/lark-contract-fixture.js';

const roots: string[] = [];

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'minori-lark-contract-'));
  roots.push(path);
  return path;
}

function digest(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

async function writeFixtureSet(base: string, options: {
  cliVersion?: string;
  data?: unknown;
  state?: 'verified' | 'unavailable' | 'not_exercised_by_policy';
  caseId?: string;
  fixtureMode?: 'envelope_only' | 'envelope_data';
} = {}) {
  const cliVersion = options.cliVersion ?? '1.0.84';
  const fixtureRoot = join(base, `cli-${cliVersion}`);
  await mkdir(fixtureRoot, { recursive: true });
  const lockfilePath = join(base, 'package-lock.json');
  await writeFile(lockfilePath, canonicalJson({
    packages: { 'node_modules/@larksuite/cli': { version: '1.0.84' } },
  }));
  const state = options.state ?? 'verified';
  const caseId = options.caseId ?? 'wiki.spaceList.default';
  const fixtureMode = options.fixtureMode ?? 'envelope_data';
  const entry: Record<string, unknown> = {
    caseId,
    commandVariant: caseId.split('.').slice(0, 2).join('.'),
    fixtureMode,
    operationCategory: caseId.startsWith('auth.') ? 'lark_auth_unavailable' : 'knowledge_contract_error',
    state,
    unclassifiedStringFields: [],
  };
  if (state === 'verified') {
    const data = options.data ?? { spaces: [] };
    const envelope = fixtureMode === 'envelope_only'
      ? data
      : { ok: true, identity: 'user', data };
    const envelopeText = canonicalJson(envelope);
    const envelopePath = `${caseId}.envelope.json`;
    await writeFile(join(fixtureRoot, envelopePath), envelopeText);
    Object.assign(entry, {
      envelopePath,
      envelopeSha256: digest(envelopeText),
    });
    if (fixtureMode === 'envelope_data') {
      const dataText = canonicalJson(data);
      const dataPath = `${caseId}.data.json`;
      await writeFile(join(fixtureRoot, dataPath), dataText);
      Object.assign(entry, {
        dataPath,
        dataSha256: digest(dataText),
        owningTest: 'test/lark/knowledge-service.contract.test.ts',
      });
    }
  }
  const manifestPath = join(fixtureRoot, 'manifest.json');
  await writeFile(manifestPath, canonicalJson({
    cliVersion,
    capturedAt: '2026-08-12T12:00:00.000Z',
    cases: [entry],
  }));
  return { fixtureRoot, manifestPath, lockfilePath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Lark Contract Manifest', () => {
  it('verifies canonical paired fixtures against the lockfile version', async () => {
    const paths = await writeFixtureSet(await root());
    await expect(verifyFixtureSet(paths)).resolves.toBeUndefined();
  });

  it('allows auth.status as the only envelope-only verified case', async () => {
    const paths = await writeFixtureSet(await root(), {
      caseId: 'auth.status.default', fixtureMode: 'envelope_only',
      data: { identity: 'user', identities: { user: { available: true, status: 'ready' } } },
    });
    await expect(verifyFixtureSet(paths)).resolves.toBeUndefined();

    const invalid = await writeFixtureSet(await root(), {
      caseId: 'wiki.spaceList.default', fixtureMode: 'envelope_only',
    });
    await expect(verifyFixtureSet(invalid)).rejects.toThrow('lark_contract_manifest_invalid');
  });

  it('records unavailable cases without inventing fixture files', async () => {
    const paths = await writeFixtureSet(await root(), { state: 'unavailable' });
    await expect(verifyFixtureSet(paths)).resolves.toBeUndefined();
  });

  it('loads verified fixtures by case and keeps auth envelope-only', async () => {
    const paths = await writeFixtureSet(await root());
    await expect(loadFixtureData('wiki.spaceList.default', paths.fixtureRoot))
      .resolves.toEqual({ spaces: [] });
    await expect(loadFixtureEnvelope('wiki.spaceList.default', paths.fixtureRoot))
      .resolves.toMatchObject({ ok: true, data: { spaces: [] } });

    const auth = await writeFixtureSet(await root(), {
      caseId: 'auth.status.default', fixtureMode: 'envelope_only',
      data: { identity: 'user', identities: { user: { available: true, status: 'ready' } } },
    });
    await expect(loadFixtureData('auth.status.default', auth.fixtureRoot))
      .rejects.toThrow('lark_contract_fixture_has_no_data');
  });

  it('rejects data drift and CLI version drift', async () => {
    const paths = await writeFixtureSet(await root());
    await writeFile(join(paths.fixtureRoot, 'wiki.spaceList.default.data.json'), canonicalJson({ spaces: ['drift'] }));
    await expect(verifyFixtureSet(paths)).rejects.toThrow('lark_contract_fixture_invalid');

    const versionPaths = await writeFixtureSet(await root(), { cliVersion: '1.0.85' });
    await expect(verifyFixtureSet(versionPaths)).rejects.toThrow('lark_contract_version_mismatch');
  });

  it('rejects correctly hashed fixture files that still contain raw strings', async () => {
    const base = await root();
    const paths = await writeFixtureSet(base, { data: { spaces: ['private space name'] } });

    await expect(verifyFixtureSet(paths)).rejects.toThrow('lark_contract_residue_detected');
  });

  it('atomically replaces a target only after staging verifies', async () => {
    const base = await root();
    const staged = await writeFixtureSet(join(base, 'staged'));
    const targetParent = join(base, 'target');
    const targetRoot = join(targetParent, 'cli-1.0.84');
    await mkdir(targetRoot, { recursive: true });
    await writeFile(join(targetRoot, 'old.txt'), 'old');

    await installFixtureSetAtomically({
      stagedRoot: staged.fixtureRoot,
      targetRoot,
      lockfilePath: staged.lockfilePath,
    });

    await expect(readFile(join(targetRoot, 'manifest.json'), 'utf8')).resolves
      .toContain('wiki.spaceList.default');
    await expect(readFile(join(targetRoot, 'old.txt'), 'utf8')).rejects.toThrow();
  });
});
