import { describe, expect, it, vi } from 'vitest';
import { createMeetingTools } from '../../src/agent/meeting-tools.js';
import { SourceRegistry } from '../../src/agent/sources.js';
import { LarkCliError } from '../../src/lark/errors.js';
import type { MeetingService } from '../../src/lark/meeting-service.js';

function meetingService(): MeetingService {
  return {
    resolvePeople: vi.fn().mockImplementation(async (names: string[]) => (
      names.map((name) => ({ status: 'resolved' as const, name, openId: `ou_${name}` }))
    )),
    searchMeetings: vi.fn().mockResolvedValue({
      status: 'complete',
      items: [{
        kind: 'meeting', meetingId: 'm_1', title: 'DevX weekly',
        start: '2026-08-11T09:00:00Z', url: 'https://acme.feishu.cn/video/m_1',
      }],
      rawCount: 1, validCount: 1, omittedCount: 0,
    }),
    getMeetingDetails: vi.fn().mockResolvedValue([]),
    searchMinutes: vi.fn().mockResolvedValue({
      status: 'complete', items: [], rawCount: 0, validCount: 0, omittedCount: 0,
    }),
    fetchContent: vi.fn(),
  };
}

const TOOL_CONTEXT = { toolCallId: 'meeting_call', messages: [] };

describe('createMeetingTools', () => {
  it('exposes only the three strict meeting tools and resolves recent participant search', async () => {
    const service = meetingService();
    const tools = createMeetingTools(
      service, new SourceRegistry(), { record: vi.fn() },
      () => new Date('2026-08-12T12:00:00Z'),
    );

    expect(Object.keys(tools)).toEqual([
      'searchMeetings', 'searchMeetingMinutes', 'fetchMeetingContent',
    ]);
    const schema = tools.searchMeetings.inputSchema as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(schema.safeParse({
      participantNames: ['Alice'], range: { kind: 'recent' },
    }).success).toBe(true);
    expect(schema.safeParse({
      participantNames: ['Alice'], range: { kind: 'recent' }, rawCommand: 'vc delete',
    }).success).toBe(false);

    await expect(tools.searchMeetings.execute?.({
      participantNames: ['Alice'], range: { kind: 'recent' },
    }, TOOL_CONTEXT)).resolves.toEqual({
      status: 'complete',
      results: [{
        meetingRef: 'meeting_ref_1', title: 'DevX weekly',
        start: '2026-08-11T09:00:00Z', url: 'https://acme.feishu.cn/video/m_1',
      }],
      rawCount: 1, validCount: 1, omittedCount: 0,
    });
    expect(service.resolvePeople).toHaveBeenCalledWith(['Alice'], undefined);
    expect(service.searchMeetings).toHaveBeenCalledWith({
      start: '2026-07-13T12:00:00.000Z', end: '2026-08-12T12:00:00.000Z',
      participantIds: ['ou_Alice'], pageSize: 30,
    }, undefined);
    expect(JSON.stringify(await tools.searchMeetings.execute?.({
      participantNames: ['Alice'], range: { kind: 'recent' },
    }, TOOL_CONTEXT))).not.toMatch(/meeting_id|open_id|page_token|ou_Alice/u);
  });

  it('splits multi-month searches, deduplicates boundaries, and hides provider cursors', async () => {
    const service = meetingService();
    service.resolvePeople = vi.fn().mockResolvedValue([]);
    service.searchMeetings = vi.fn().mockImplementation(async (input) => ({
      status: 'complete' as const,
      items: [{
        kind: 'meeting' as const,
        meetingId: input.pageToken ? 'm_page_2' : 'm_boundary',
        title: input.pageToken ? 'Page two' : 'Boundary meeting',
        start: input.start!,
      }],
      rawCount: 1, validCount: 1, omittedCount: 0,
      ...(!input.pageToken && input.start === '2026-01-31T12:00:00.000Z'
        ? { nextPageToken: 'provider_secret_page_2' }
        : {}),
    }));
    const tools = createMeetingTools(
      service, new SourceRegistry(), { record: vi.fn() },
      () => new Date('2026-08-12T12:00:00Z'),
    );
    const input = {
      range: {
        kind: 'explicit' as const,
        start: '2026-01-31T12:00:00Z',
        end: '2026-04-02T12:00:00Z',
      },
    };

    const first = await tools.searchMeetings.execute?.(input, TOOL_CONTEXT);
    expect(service.searchMeetings).toHaveBeenCalledTimes(3);
    expect(service.searchMeetings).toHaveBeenNthCalledWith(1, expect.objectContaining({
      start: '2026-01-31T12:00:00.000Z', end: '2026-02-28T12:00:00.000Z',
    }), undefined);
    expect(service.searchMeetings).toHaveBeenNthCalledWith(2, expect.objectContaining({
      start: '2026-02-28T12:00:00.000Z', end: '2026-03-28T12:00:00.000Z',
    }), undefined);
    expect(first).toMatchObject({
      results: [{ meetingRef: 'meeting_ref_1', title: 'Boundary meeting' }],
      nextCursor: expect.stringMatching(/^meeting_cursor_/u),
    });
    expect(JSON.stringify(first)).not.toContain('provider_secret_page_2');

    const cursor = (first as { nextCursor: string }).nextCursor;
    await tools.searchMeetings.execute?.({ ...input, cursor }, TOOL_CONTEXT);
    expect(service.searchMeetings).toHaveBeenLastCalledWith(expect.objectContaining({
      pageToken: 'provider_secret_page_2',
    }), undefined);
    await tools.searchMeetings.execute?.({ ...input, cursor }, TOOL_CONTEXT);
    expect(service.searchMeetings).toHaveBeenLastCalledWith(expect.objectContaining({
      pageToken: 'provider_secret_page_2',
    }), undefined);

    const callsBeforeRestart = vi.mocked(service.searchMeetings).mock.calls.length;
    await tools.searchMeetings.execute?.({ ...input, cursor: 'invented' }, TOOL_CONTEXT);
    expect(vi.mocked(service.searchMeetings).mock.calls.length - callsBeforeRestart).toBe(3);
  });

  it('asks for clarification before searching ambiguous or unresolved people', async () => {
    const service = meetingService();
    service.resolvePeople = vi.fn().mockResolvedValue([
      { status: 'ambiguous', name: 'Alex', candidates: ['Alex / Design', 'Alex / Platform'] },
      { status: 'unresolved', name: 'Missing' },
    ]);
    const record = vi.fn();
    const tools = createMeetingTools(service, new SourceRegistry(), { record });

    await expect(tools.searchMeetings.execute?.({
      participantNames: ['Alex', 'Missing'], range: { kind: 'recent' },
    }, TOOL_CONTEXT)).resolves.toEqual({
      status: 'needs_clarification',
      ambiguous: [{ name: 'Alex', candidates: ['Alex / Design', 'Alex / Platform'] }],
      unresolved: ['Missing'],
    });
    expect(service.searchMeetings).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith({
      toolName: 'searchMeetings', success: false,
      errorCategory: 'meeting_participant_ambiguous',
    });
  });

  it('searches independent Minutes with resolved owner and participant names', async () => {
    const service = meetingService();
    service.searchMinutes = vi.fn().mockResolvedValue({
      status: 'complete',
      items: [{
        kind: 'minute', minuteToken: 'obc_1', title: 'Customer interview',
        createdAt: '2026-08-10T10:00:00Z',
      }],
      rawCount: 1, validCount: 1, omittedCount: 0,
    });
    const tools = createMeetingTools(
      service, new SourceRegistry(), { record: vi.fn() },
      () => new Date('2026-08-12T12:00:00Z'),
    );

    await expect(tools.searchMeetingMinutes.execute?.({
      query: 'customer', ownerNames: ['Alice'], participantNames: ['Bob'],
      range: { kind: 'recent' },
    }, TOOL_CONTEXT)).resolves.toMatchObject({
      results: [{ meetingRef: 'meeting_ref_1', title: 'Customer interview' }],
    });
    expect(service.searchMinutes).toHaveBeenCalledWith(expect.objectContaining({
      query: 'customer', ownerIds: ['ou_Alice'], participantIds: ['ou_Bob'],
    }), undefined);
  });

  it('caches and pages fetched content, registers its real type, and recovers unknown cursors', async () => {
    const service = meetingService();
    const body = `${'A'.repeat(12_000)}${'B'.repeat(3_000)}`;
    service.fetchContent = vi.fn().mockResolvedValue({
      status: 'loaded', kind: 'smart_note_ai_summary', title: 'DevX weekly',
      meetingTime: '2026-08-11T09:00:00Z',
      url: 'https://acme.feishu.cn/docx/dox_note_1', text: body,
    });
    const record = vi.fn();
    const tools = createMeetingTools(service, new SourceRegistry(), { record });
    await tools.searchMeetings.execute?.({ range: { kind: 'recent' } }, TOOL_CONTEXT);

    const first = await tools.fetchMeetingContent.execute?.({
      meetingRef: 'meeting_ref_1', contentKind: 'auto', artifactPreference: 'auto',
    }, TOOL_CONTEXT);
    expect(first).toMatchObject({
      content: 'A'.repeat(12_000),
      contentType: 'smart_note_ai_summary',
      source: {
        id: 1,
        title: '[Smart Meeting Note AI summary] DevX weekly — 2026-08-11T09:00:00Z',
        url: 'https://acme.feishu.cn/docx/dox_note_1',
      },
      nextCursor: expect.stringMatching(/^meeting_cursor_/u),
      truncated: true,
    });
    const cursor = (first as { nextCursor: string }).nextCursor;
    await expect(tools.fetchMeetingContent.execute?.({
      meetingRef: 'meeting_ref_1', contentKind: 'auto', artifactPreference: 'auto', cursor,
    }, TOOL_CONTEXT)).resolves.toMatchObject({ content: 'B'.repeat(3_000), truncated: false });
    await expect(tools.fetchMeetingContent.execute?.({
      meetingRef: 'meeting_ref_1', contentKind: 'auto', artifactPreference: 'auto',
      cursor: 'invented',
    }, TOOL_CONTEXT)).resolves.toMatchObject({ content: 'A'.repeat(12_000) });
    expect(service.fetchContent).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      toolName: 'fetchMeetingContent', success: true,
      fetchedCount: 1, contentKind: 'smart_note_ai_summary',
    });
  });

  it('does not impose a hard five-artifact fetch cap', async () => {
    const service = meetingService();
    service.searchMeetings = vi.fn().mockResolvedValue({
      status: 'complete',
      items: Array.from({ length: 6 }, (_, index) => ({
        kind: 'meeting' as const, meetingId: `m_${index + 1}`,
        title: `Meeting ${index + 1}`, start: '2026-08-11T09:00:00Z',
      })),
      rawCount: 6, validCount: 6, omittedCount: 0,
    });
    service.fetchContent = vi.fn().mockImplementation(async (reference) => ({
      status: 'loaded' as const, kind: 'minute_ai_summary' as const,
      title: reference.title, text: 'Summary',
    }));
    const tools = createMeetingTools(service, new SourceRegistry(), { record: vi.fn() });
    await tools.searchMeetings.execute?.({ range: { kind: 'recent' } }, TOOL_CONTEXT);

    for (let index = 1; index <= 6; index += 1) {
      await expect(tools.fetchMeetingContent.execute?.({
        meetingRef: `meeting_ref_${index}`,
        contentKind: 'auto', artifactPreference: 'auto',
      }, TOOL_CONTEXT)).resolves.toMatchObject({ content: 'Summary' });
    }
    expect(service.fetchContent).toHaveBeenCalledTimes(6);
  });

  it('serializes same-run meeting operations without blocking unrelated tool factories', async () => {
    const service = meetingService();
    let active = 0;
    let maxActive = 0;
    service.searchMeetings = vi.fn().mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        status: 'complete' as const, items: [],
        rawCount: 0, validCount: 0, omittedCount: 0,
      };
    });
    const tools = createMeetingTools(service, new SourceRegistry(), { record: vi.fn() });

    await Promise.all([
      tools.searchMeetings.execute?.({ range: { kind: 'recent' } }, TOOL_CONTEXT),
      tools.searchMeetings.execute?.({ range: { kind: 'recent' } }, TOOL_CONTEXT),
    ]);
    expect(maxActive).toBe(1);
  });

  it('preserves cancellation without inventing a meeting failure audit category', async () => {
    const service = meetingService();
    const aborted = new LarkCliError('aborted');
    service.fetchContent = vi.fn().mockRejectedValue(aborted);
    const record = vi.fn();
    const tools = createMeetingTools(service, new SourceRegistry(), { record });
    await tools.searchMeetings.execute?.({ range: { kind: 'recent' } }, TOOL_CONTEXT);
    record.mockClear();

    await expect(tools.fetchMeetingContent.execute?.({
      meetingRef: 'meeting_ref_1', contentKind: 'auto', artifactPreference: 'auto',
    }, TOOL_CONTEXT)).rejects.toBe(aborted);
    expect(record).not.toHaveBeenCalled();
  });
});
