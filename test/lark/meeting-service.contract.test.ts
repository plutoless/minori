import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { LarkCommand } from '../../src/lark/command-catalog.js';
import { MeetingContractError } from '../../src/lark/errors.js';
import { LarkMeetingService } from '../../src/lark/meeting-service.js';
import type { LarkExecutor } from '../../src/lark/runner.js';

async function fixture(name: string) {
  const path = fileURLToPath(new URL(`../fixtures/lark/${name}`, import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function executorWith(respond: (command: LarkCommand) => unknown) {
  const run = vi.fn(async (command: LarkCommand) => respond(command));
  return { run } as unknown as LarkExecutor & { run: typeof run };
}

describe('LarkMeetingService', () => {
  it('resolves only unique exact participant names and bounds ambiguous candidates', async () => {
    const data = await fixture('contact-search-user.json');
    const executor = executorWith(() => data);
    const service = new LarkMeetingService(executor);
    const signal = new AbortController().signal;

    await expect(service.resolvePeople(['Alice', 'Alex', 'Missing'], signal)).resolves.toEqual([
      { status: 'resolved', name: 'Alice', openId: 'ou_alice' },
      { status: 'ambiguous', name: 'Alex', candidates: ['Alex / Design', 'Alex / Platform'] },
      { status: 'unresolved', name: 'Missing' },
    ]);
    expect(executor.run.mock.calls).toEqual([
      [{ id: 'contact.searchUser', query: 'Alice', pageSize: 30 }, signal],
      [{ id: 'contact.searchUser', query: 'Alex', pageSize: 30 }, signal],
      [{ id: 'contact.searchUser', query: 'Missing', pageSize: 30 }, signal],
    ]);
    expect(JSON.stringify(await service.resolvePeople(['Alex']))).not.toContain('ou_alex');
  });

  it('normalizes meeting search rows independently and preserves completeness', async () => {
    const data = await fixture('vc-search.json');
    const executor = executorWith(() => data);
    const service = new LarkMeetingService(executor);
    const signal = new AbortController().signal;

    await expect(service.searchMeetings({
      start: '2026-08-01T00:00:00Z', end: '2026-08-12T00:00:00Z',
      participantIds: ['ou_alice'], pageSize: 30,
    }, signal)).resolves.toEqual({
      status: 'partial',
      items: [
        {
          kind: 'meeting', meetingId: 'm_1', title: 'DevX weekly',
          start: '2026-08-11T09:00:00Z', end: '2026-08-11T10:00:00Z',
          url: 'https://example.feishu.cn/video/m_1',
        },
        {
          kind: 'meeting', meetingId: 'm_2', title: 'DevX review',
          start: '2026-08-10T09:00:00Z',
        },
      ],
      rawCount: 3, validCount: 2, omittedCount: 1, nextPageToken: 'vc_page_2',
    });
    expect(executor.run).toHaveBeenCalledWith({
      id: 'vc.search', start: '2026-08-01T00:00:00Z', end: '2026-08-12T00:00:00Z',
      participantIds: ['ou_alice'], pageSize: 30,
    }, signal);
  });

  it('normalizes independent Minute search and meeting detail responses', async () => {
    const minuteData = await fixture('minutes-search.json');
    const detailData = await fixture('vc-detail.json');
    const executor = executorWith((command) => (
      command.id === 'minutes.search' ? minuteData : detailData
    ));
    const service = new LarkMeetingService(executor);

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
    const service = new LarkMeetingService(executor);

    const error = await service.searchMeetings({ query: 'private query', pageSize: 30 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MeetingContractError);
    expect(error).toMatchObject({
      code: 'meeting_contract_error',
      completeness: { rawCount: 1, validCount: 0, omittedCount: 1 },
    });
    expect(JSON.stringify(error)).not.toMatch(/private|ou_/u);
  });
});
