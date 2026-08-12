import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LarkCommand } from '../../src/lark/command-catalog.js';
import { MeetingContractError } from '../../src/lark/errors.js';
import { LarkCliError, MeetingContentError } from '../../src/lark/errors.js';
import type {
  MeetingArtifactStore,
  MeetingByteBudget,
} from '../../src/lark/meeting-artifacts.js';
import {
  LarkMeetingService,
  type MeetingArtifactReference,
} from '../../src/lark/meeting-service.js';
import type { KnowledgeReader } from '../../src/lark/knowledge-service.js';
import type { LarkExecutor } from '../../src/lark/runner.js';

async function fixture(name: string) {
  const path = fileURLToPath(new URL(`../fixtures/lark/${name}`, import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function executorWith(respond: (command: LarkCommand) => unknown) {
  const run = vi.fn(async (command: LarkCommand) => respond(command));
  return { run } as unknown as LarkExecutor & { run: typeof run };
}

function knowledgeWith(fetch: (doc: string) => unknown) {
  const fetchDocument = vi.fn(async ({ doc }: { doc: string }) => fetch(doc));
  return {
    fetchDocument,
    search: vi.fn(),
    listSpaces: vi.fn(),
    listNodes: vi.fn(),
    getNode: vi.fn(),
  } as unknown as KnowledgeReader & { fetchDocument: typeof fetchDocument };
}

function artifactStoreWith(text: string) {
  const readFile = vi.fn(async () => text);
  const withDirectory = vi.fn(async <T>(operation: (directory: string) => Promise<T>) => (
    operation('/safe/minori-meeting-run')
  ));
  return { readFile, withDirectory } as MeetingArtifactStore & {
    readFile: typeof readFile;
    withDirectory: typeof withDirectory;
  };
}

const MEETING_REF: MeetingArtifactReference = {
  kind: 'meeting', meetingId: 'm_1', title: 'DevX weekly',
  start: '2026-08-11T09:00:00Z', url: 'https://example.feishu.cn/video/m_1',
};

const MINUTE_REF: MeetingArtifactReference = {
  kind: 'minute', minuteToken: 'obc_1', title: 'DevX weekly recording',
  start: '2026-08-11T09:00:00Z', url: 'https://example.feishu.cn/minutes/obc_1',
};

const BUDGET = (): MeetingByteBudget => ({ remaining: 24 * 1024 * 1024 });

describe('LarkMeetingService', () => {
  it('resolves only unique exact participant names and bounds ambiguous candidates', async () => {
    const data = await fixture('contact-search-user.json');
    const executor = executorWith(() => data);
    const service = new LarkMeetingService(
      executor, knowledgeWith(() => undefined), artifactStoreWith('unused'),
    );
    const signal = new AbortController().signal;

    await expect(service.resolvePeople(['Alice', 'Alex', 'Missing'], signal)).resolves.toEqual([
      { status: 'resolved', name: 'Alice', openId: 'ou_alice' },
      { status: 'ambiguous', name: 'Alex', candidates: ['Alex'] },
      { status: 'unresolved', name: 'Missing' },
    ]);
    expect(executor.run.mock.calls).toEqual([
      [{ id: 'contact.searchUser', query: 'Alice', pageSize: 30 }, signal],
      [{ id: 'contact.searchUser', query: 'Alex', pageSize: 30 }, signal],
      [{ id: 'contact.searchUser', query: 'Missing', pageSize: 30 }, signal],
    ]);
    expect(JSON.stringify(await service.resolvePeople(['Alex']))).not.toContain('ou_alex');
    expect(JSON.stringify(await service.resolvePeople(['Alex']))).not.toMatch(/Design|Platform/u);
  });

  it('normalizes meeting search rows independently and preserves completeness', async () => {
    const data = await fixture('vc-search.json');
    const executor = executorWith(() => data);
    const service = new LarkMeetingService(
      executor, knowledgeWith(() => undefined), artifactStoreWith('unused'),
    );
    const signal = new AbortController().signal;

    await expect(service.searchMeetings({
      start: '2026-08-10T00:00:00Z', end: '2026-08-12T00:00:00Z',
      participantIds: ['ou_alice'], pageSize: 30,
    }, signal)).resolves.toEqual({
      status: 'partial',
      items: [
        {
          kind: 'meeting', meetingId: 'm_1', title: 'DevX weekly',
          url: 'https://example.feishu.cn/video/m_1',
        },
        { kind: 'meeting', meetingId: 'm_2', title: '未命名会议' },
      ],
      rawCount: 4, validCount: 2, omittedCount: 2, nextPageToken: 'vc_page_2',
    });
    expect(executor.run).toHaveBeenCalledWith({
      id: 'vc.search', start: '2026-08-10T00:00:00Z', end: '2026-08-12T00:00:00Z',
      participantIds: ['ou_alice'], pageSize: 30,
    }, signal);
    expect(JSON.stringify(await service.searchMeetings({
      start: '2026-08-10T00:00:00Z', end: '2026-08-12T00:00:00Z', pageSize: 30,
    }))).not.toContain('provider-formatted display text');
  });

  it('normalizes independent Minute search and meeting detail responses', async () => {
    const minuteData = await fixture('minutes-search.json');
    const detailData = await fixture('vc-detail.json');
    const executor = executorWith((command) => (
      command.id === 'minutes.search' ? minuteData : detailData
    ));
    const service = new LarkMeetingService(
      executor, knowledgeWith(() => undefined), artifactStoreWith('unused'),
    );

    await expect(service.searchMinutes({ query: 'DevX', pageSize: 30 })).resolves.toEqual({
      status: 'partial',
      items: [{
        kind: 'minute', minuteToken: 'obc_2', title: 'Uploaded customer interview',
        createdAt: '2026-08-09T08:00:00Z',
        url: 'https://example.feishu.cn/minutes/obc_2',
      }],
      rawCount: 2, validCount: 1, omittedCount: 1,
    });
    await expect(service.getMeetingDetails(['m_1'])).resolves.toEqual([{
      meetingId: 'm_1', title: 'DevX weekly', start: '2026-08-11T09:00:00Z',
      end: '2026-08-11T10:00:00Z', noteId: 'note_1', minuteToken: 'obc_1',
    }]);
  });

  it('fails a non-empty all-invalid result set without retaining raw rows', async () => {
    const executor = executorWith(() => ({
      items: [{ topic: 'private title', participant_ids: ['ou_private'] }],
      has_more: false,
    }));
    const service = new LarkMeetingService(
      executor, knowledgeWith(() => undefined), artifactStoreWith('unused'),
    );

    const error = await service.searchMeetings({ query: 'private query', pageSize: 30 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MeetingContractError);
    expect(error).toMatchObject({
      code: 'meeting_contract_error',
      completeness: { rawCount: 1, validCount: 0, omittedCount: 1 },
    });
    expect(JSON.stringify(error)).not.toMatch(/private|ou_/u);
  });

  it('prefers the Smart Meeting Note AI summary for meeting and direct Minute references', async () => {
    const detail = await fixture('vc-detail.json');
    const note = await fixture('note-detail-normal.json');
    const minuteBasic = { minutes: [{ minute_token: 'obc_1', title: 'Minute', note_id: 'note_1' }] };
    const executor = executorWith((command) => {
      if (command.id === 'vc.detail') return detail;
      if (command.id === 'note.detail') return note;
      if (command.id === 'minutes.detail' && command.artifact === 'basic') return minuteBasic;
      throw new Error(`unexpected ${command.id}`);
    });
    const knowledge = knowledgeWith((doc) => ({
      token: doc, title: 'DevX AI note', url: 'https://example.feishu.cn/docx/dox_note_summary',
      markdown: '# AI summary\n\nDecision: ship.', revisionId: 1,
    }));
    const service = new LarkMeetingService(executor, knowledge, artifactStoreWith('unused'));

    await expect(service.fetchContent(MEETING_REF, {
      contentKind: 'auto', artifactPreference: 'auto',
    }, BUDGET())).resolves.toMatchObject({
      status: 'loaded', kind: 'smart_note_ai_summary',
      text: expect.stringContaining('Decision: ship.'),
    });
    await expect(service.fetchContent(MINUTE_REF, {
      contentKind: 'auto', artifactPreference: 'auto',
    }, BUDGET())).resolves.toMatchObject({ kind: 'smart_note_ai_summary' });
    expect(knowledge.fetchDocument).toHaveBeenCalledWith(
      { doc: 'dox_note_summary' }, undefined,
    );
  });

  it('falls back from an unreadable Smart Meeting Note to the Minute summary', async () => {
    const detail = await fixture('vc-detail.json');
    const note = await fixture('note-detail-normal.json');
    const minuteSummary = await fixture('minutes-detail-summary.json');
    const executor = executorWith((command) => {
      if (command.id === 'vc.detail') return detail;
      if (command.id === 'note.detail') return note;
      if (command.id === 'minutes.detail' && command.artifact === 'summary') {
        return minuteSummary;
      }
      throw new Error(`unexpected ${command.id}`);
    });
    const knowledge = knowledgeWith(() => {
      throw new LarkCliError('cli_error', { subtype: 'permission' });
    });
    const service = new LarkMeetingService(executor, knowledge, artifactStoreWith('unused'));

    await expect(service.fetchContent(MEETING_REF, {
      contentKind: 'auto', artifactPreference: 'auto',
    }, BUDGET())).resolves.toMatchObject({
      kind: 'minute_ai_summary', text: 'Minute AI summary',
    });
  });

  it('does not substitute Minute content when Smart Meeting Note is explicitly required', async () => {
    const detail = await fixture('vc-detail.json');
    const note = await fixture('note-detail-normal.json');
    const executor = executorWith((command) => (
      command.id === 'vc.detail' ? detail : note
    ));
    const knowledge = knowledgeWith(() => {
      throw new LarkCliError('cli_error', { subtype: 'permission' });
    });
    const service = new LarkMeetingService(executor, knowledge, artifactStoreWith('unused'));

    await expect(service.fetchContent(MEETING_REF, {
      contentKind: 'summary', artifactPreference: 'smart_note',
    }, BUDGET())).rejects.toBeInstanceOf(MeetingContentError);
    expect(executor.run.mock.calls.some(([command]) => (
      command.id === 'minutes.detail'
    ))).toBe(false);
  });

  it('routes normal Note transcript to Docs and unified Note transcript to a run-owned file', async () => {
    const detail = await fixture('vc-detail.json');
    const normal = await fixture('note-detail-normal.json');
    const unified = await fixture('note-detail-unified.json');
    const artifacts = artifactStoreWith('Unified original transcript');
    let useUnified = false;
    const executor = executorWith((command) => {
      if (command.id === 'vc.detail') return detail;
      if (command.id === 'note.detail') return useUnified ? unified : normal;
      if (command.id === 'note.transcript') {
        return { note_id: 'note_1', transcript_file: 'unified_transcript.md' };
      }
      throw new Error(`unexpected ${command.id}`);
    });
    const knowledge = knowledgeWith((doc) => ({
      token: doc, title: 'Original transcript', url: 'https://example.feishu.cn/docx/transcript',
      markdown: 'Normal original transcript', revisionId: 1,
    }));
    const service = new LarkMeetingService(executor, knowledge, artifacts);

    await expect(service.fetchContent(MEETING_REF, {
      contentKind: 'transcript', artifactPreference: 'smart_note',
    }, BUDGET())).resolves.toMatchObject({
      kind: 'smart_note_transcript', text: 'Normal original transcript',
    });
    expect(knowledge.fetchDocument).toHaveBeenLastCalledWith(
      { doc: 'dox_note_transcript' }, undefined,
    );

    useUnified = true;
    await expect(service.fetchContent(MEETING_REF, {
      contentKind: 'transcript', artifactPreference: 'smart_note',
    }, BUDGET())).resolves.toMatchObject({
      kind: 'smart_note_transcript', text: 'Unified original transcript',
    });
    expect(executor.run).toHaveBeenCalledWith({
      id: 'note.transcript', noteId: 'note_1', workDir: '/safe/minori-meeting-run',
    });
    expect(artifacts.readFile).toHaveBeenCalledWith(
      '/safe/minori-meeting-run', 'unified_transcript.md', expect.any(Object),
    );
  });

  it('reads a direct Minute transcript through the artifact store', async () => {
    const transcript = await fixture('minutes-detail-transcript.json');
    const artifacts = artifactStoreWith('Minute original transcript');
    const executor = executorWith((command) => {
      if (command.id === 'minutes.detail' && command.artifact === 'transcript') return transcript;
      throw new Error(`unexpected ${command.id}`);
    });
    const service = new LarkMeetingService(
      executor, knowledgeWith(() => undefined), artifacts,
    );

    await expect(service.fetchContent(MINUTE_REF, {
      contentKind: 'transcript', artifactPreference: 'minute',
    }, BUDGET())).resolves.toMatchObject({
      kind: 'minute_transcript', text: 'Minute original transcript',
    });
    expect(executor.run).toHaveBeenCalledWith({
      id: 'minutes.detail', minuteTokens: ['obc_1'], artifact: 'transcript',
      workDir: '/safe/minori-meeting-run',
    });
  });

  it('falls back to an original transcript only when auto has no readable summary', async () => {
    const detail = await fixture('vc-detail.json');
    const note = {
      note_id: 'note_1', note_display_type: 'normal',
      verbatim_doc_token: 'dox_note_transcript',
    };
    const executor = executorWith((command) => {
      if (command.id === 'vc.detail') return detail;
      if (command.id === 'note.detail') return note;
      throw new LarkCliError('cli_error', { subtype: 'not_found' });
    });
    const knowledge = knowledgeWith((doc) => ({
      token: doc, title: 'Original transcript',
      url: 'https://example.feishu.cn/docx/transcript',
      markdown: 'Original wording', revisionId: 1,
    }));
    const service = new LarkMeetingService(executor, knowledge, artifactStoreWith('unused'));

    await expect(service.fetchContent(MEETING_REF, {
      contentKind: 'auto', artifactPreference: 'auto',
    }, BUDGET())).resolves.toMatchObject({
      kind: 'smart_note_transcript', text: 'Original wording',
    });
  });

  it('renders only allowlisted Minute todo and chapter content', async () => {
    const executor = executorWith((command) => {
      if (command.id !== 'minutes.detail') throw new Error(`unexpected ${command.id}`);
      if (command.artifact === 'todo') {
        return { minutes: [{
          minute_token: 'obc_1', title: 'Minute',
          artifacts: { todos: [{ content: 'Follow up', private_id: 'secret' }] },
        }] };
      }
      if (command.artifact === 'chapter') {
        return { minutes: [{
          minute_token: 'obc_1', title: 'Minute',
          artifacts: { chapters: [{ title: 'Decision', private_id: 'secret' }] },
        }] };
      }
      throw new Error(`unexpected artifact ${command.artifact}`);
    });
    const service = new LarkMeetingService(
      executor, knowledgeWith(() => undefined), artifactStoreWith('unused'),
    );

    await expect(service.fetchContent(MINUTE_REF, {
      contentKind: 'todos', artifactPreference: 'minute',
    }, BUDGET())).resolves.toMatchObject({ kind: 'minute_todos', text: '- Follow up' });
    await expect(service.fetchContent(MINUTE_REF, {
      contentKind: 'chapters', artifactPreference: 'minute',
    }, BUDGET())).resolves.toMatchObject({ kind: 'minute_chapters', text: '- Decision' });
    expect(JSON.stringify(await service.fetchContent(MINUTE_REF, {
      contentKind: 'todos', artifactPreference: 'minute',
    }, BUDGET()))).not.toContain('secret');
  });

  it('preserves abort rather than trying another artifact', async () => {
    const detail = await fixture('vc-detail.json');
    const note = await fixture('note-detail-normal.json');
    const executor = executorWith((command) => (
      command.id === 'vc.detail' ? detail : note
    ));
    const knowledge = knowledgeWith(() => {
      throw new LarkCliError('aborted');
    });
    const service = new LarkMeetingService(executor, knowledge, artifactStoreWith('unused'));

    await expect(service.fetchContent(MEETING_REF, {
      contentKind: 'auto', artifactPreference: 'auto',
    }, BUDGET())).rejects.toMatchObject({ code: 'aborted' });
    expect(executor.run.mock.calls.some(([command]) => (
      command.id === 'minutes.detail'
    ))).toBe(false);
  });

  it('still reads a direct Minute when its optional Smart Note association is unavailable', async () => {
    const minuteSummary = await fixture('minutes-detail-summary.json');
    const executor = executorWith((command) => {
      if (command.id !== 'minutes.detail') throw new Error(`unexpected ${command.id}`);
      if (command.artifact === 'basic') {
        throw new LarkCliError('cli_error', { subtype: 'permission' });
      }
      if (command.artifact === 'summary') return minuteSummary;
      throw new Error(`unexpected artifact ${command.artifact}`);
    });
    const service = new LarkMeetingService(
      executor, knowledgeWith(() => undefined), artifactStoreWith('unused'),
    );

    await expect(service.fetchContent(MINUTE_REF, {
      contentKind: 'auto', artifactPreference: 'auto',
    }, BUDGET())).resolves.toMatchObject({
      kind: 'minute_ai_summary', text: 'Minute AI summary',
    });
  });
});
