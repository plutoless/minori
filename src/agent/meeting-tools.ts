import { tool } from 'ai';
import { z } from 'zod';
import { LarkCliError, MeetingContractError, MeetingContentError } from '../lark/errors.js';
import { createMeetingByteBudget } from '../lark/meeting-artifacts.js';
import type {
  MeetingArtifactPreference,
  MeetingArtifactReference,
  MeetingCandidate,
  MeetingContentKind,
  MeetingContentRequest,
  MeetingService,
  MinuteCandidate,
  PersonResolution,
} from '../lark/meeting-service.js';
import { SourceRegistry } from './sources.js';

export type MeetingReadAuditErrorCategory =
  | 'meeting_contract_error'
  | 'meeting_search_unavailable'
  | 'meeting_content_unavailable'
  | 'meeting_artifact_unsafe'
  | 'meeting_participant_ambiguous'
  | 'meeting_participant_unresolved';

export type MeetingReadAuditInput = {
  toolName: 'searchMeetings' | 'searchMeetingMinutes' | 'fetchMeetingContent';
  success: boolean;
  rawCount?: number;
  validCount?: number;
  omittedCount?: number;
  fetchedCount?: 0 | 1;
  contentKind?: MeetingContentKind;
  errorCategory?: MeetingReadAuditErrorCategory;
};

export interface MeetingReadAudit {
  record(input: MeetingReadAuditInput): void;
}

const rangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recent') }).strict(),
  z.object({
    kind: z.literal('explicit'),
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
  }).strict(),
]);

const NAME_SCHEMA = z.string().trim().min(1).max(100);
const CURSOR_SCHEMA = z.string().min(1).max(200);

const searchMeetingsInputSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  organizerNames: z.array(NAME_SCHEMA).max(20).optional(),
  participantNames: z.array(NAME_SCHEMA).max(20).optional(),
  range: rangeSchema,
  cursor: CURSOR_SCHEMA.optional(),
}).strict();

const searchMeetingMinutesInputSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  ownerNames: z.array(NAME_SCHEMA).max(20).optional(),
  participantNames: z.array(NAME_SCHEMA).max(20).optional(),
  range: rangeSchema,
  cursor: CURSOR_SCHEMA.optional(),
}).strict();

const fetchMeetingContentInputSchema = z.object({
  meetingRef: z.string().regex(/^meeting_ref_[1-9][0-9]*$/u),
  contentKind: z.enum(['auto', 'summary', 'todos', 'chapters', 'transcript']),
  artifactPreference: z.enum(['auto', 'smart_note', 'minute']).default('auto'),
  cursor: CURSOR_SCHEMA.optional(),
}).strict();

type SearchRange = z.infer<typeof rangeSchema>;
type ProviderWindow = { start: string; end: string; pageToken?: string };
type SearchContinuation = {
  kind: 'search';
  source: 'meeting' | 'minute';
  key: string;
  windows: ProviderWindow[];
};
type PageContinuation = {
  kind: 'content';
  key: string;
  pageIndex: number;
};

const PAGE_SIZE = 30;
const MAX_CONTENT_PAGE_CHARS = 12_000;
const RECENT_RANGE_MS = 30 * 24 * 60 * 60 * 1_000;

function addUtcMonthClamped(value: Date) {
  const targetYear = value.getUTCMonth() === 11
    ? value.getUTCFullYear() + 1
    : value.getUTCFullYear();
  const targetMonth = (value.getUTCMonth() + 1) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    Math.min(value.getUTCDate(), lastDay),
    value.getUTCHours(),
    value.getUTCMinutes(),
    value.getUTCSeconds(),
    value.getUTCMilliseconds(),
  ));
}

function splitProviderWindows(range: SearchRange, now: Date): ProviderWindow[] {
  const start = range.kind === 'recent'
    ? new Date(now.getTime() - RECENT_RANGE_MS)
    : new Date(range.start);
  const end = range.kind === 'recent' ? new Date(now) : new Date(range.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
    throw new Error('invalid_meeting_range');
  }
  const windows: ProviderWindow[] = [];
  let cursor = start;
  while (cursor < end) {
    const monthLater = addUtcMonthClamped(cursor);
    const next = monthLater < end ? monthLater : end;
    if (next <= cursor) throw new Error('invalid_meeting_range');
    windows.push({ start: cursor.toISOString(), end: next.toISOString() });
    cursor = next;
  }
  return windows;
}

function uniqueNames(...groups: Array<string[] | undefined>) {
  return [...new Set(groups.flatMap((group) => group ?? []).map((name) => name.trim()))];
}

function resolutionResult(resolutions: PersonResolution[]) {
  const ambiguous = resolutions.flatMap((result) => (
    result.status === 'ambiguous'
      ? [{ name: result.name, candidates: result.candidates }]
      : []
  ));
  const unresolved = resolutions.flatMap((result) => (
    result.status === 'unresolved' ? [result.name] : []
  ));
  const ids = new Map(resolutions.flatMap((result) => (
    result.status === 'resolved' ? [[result.name, result.openId] as const] : []
  )));
  return { ambiguous, unresolved, ids };
}

function paginate(text: string) {
  const pages: string[] = [];
  for (let index = 0; index < text.length; index += MAX_CONTENT_PAGE_CHARS) {
    pages.push(text.slice(index, index + MAX_CONTENT_PAGE_CHARS));
  }
  return pages.length > 0 ? pages : [''];
}

function contentLabel(kind: MeetingContentKind) {
  return {
    smart_note_ai_summary: 'Smart Meeting Note AI summary',
    minute_ai_summary: 'Minute AI summary',
    smart_note_todos: 'Smart Meeting Note todos',
    minute_todos: 'Minute todos',
    minute_chapters: 'Minute chapters',
    smart_note_transcript: 'Smart Meeting Note original transcript',
    minute_transcript: 'Minute original transcript',
  }[kind];
}

function safeSourceUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    const hostname = url.hostname.toLowerCase();
    const allowed = ['feishu.cn', 'larksuite.com', 'larkoffice.com'];
    return allowed.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function isRunTermination(error: unknown) {
  return error instanceof LarkCliError
    && (error.code === 'aborted' || error.code === 'timeout' || error.code === 'output_limit');
}

export function createMeetingTools(
  service: MeetingService,
  sources: SourceRegistry,
  audit: MeetingReadAudit,
  now: () => Date = () => new Date(),
) {
  const references = new Map<string, MeetingArtifactReference>();
  const referenceKeys = new Map<string, string>();
  const cursors = new Map<string, SearchContinuation | PageContinuation>();
  const snapshots = new Map<string, Awaited<ReturnType<MeetingService['fetchContent']>>>();
  const pages = new Map<string, string[]>();
  const byteBudget = createMeetingByteBudget();
  let referenceSequence = 0;
  let cursorSequence = 0;
  let meetingTail = Promise.resolve();

  const sequential = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = meetingTail.then(operation);
    meetingTail = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const referenceFor = (reference: MeetingArtifactReference) => {
    const key = reference.kind === 'meeting'
      ? `meeting:${reference.meetingId}`
      : `minute:${reference.minuteToken}`;
    const existing = referenceKeys.get(key);
    if (existing) return existing;
    const opaque = `meeting_ref_${++referenceSequence}`;
    referenceKeys.set(key, opaque);
    references.set(opaque, reference);
    return opaque;
  };

  const nextCursor = (continuation: SearchContinuation | PageContinuation) => {
    const opaque = `meeting_cursor_${++cursorSequence}`;
    cursors.set(opaque, continuation);
    return opaque;
  };

  const resolve = async (names: string[], signal?: AbortSignal) => (
    resolutionResult(await service.resolvePeople(names, signal))
  );

  const searchMeetings = tool({
    description: [
      'Search completed Feishu Meeting Records visible to the Dedicated Knowledge User.',
      'Results are discovery metadata; fetch meeting content before using it as evidence.',
    ].join(' '),
    inputSchema: searchMeetingsInputSchema,
    execute: (input, { abortSignal }) => sequential(async () => {
      const names = uniqueNames(input.organizerNames, input.participantNames);
      const people = await resolve(names, abortSignal);
      if (people.ambiguous.length > 0 || people.unresolved.length > 0) {
        const errorCategory = people.ambiguous.length > 0
          ? 'meeting_participant_ambiguous' as const
          : 'meeting_participant_unresolved' as const;
        audit.record({ toolName: 'searchMeetings', success: false, errorCategory });
        return {
          status: 'needs_clarification' as const,
          ambiguous: people.ambiguous,
          unresolved: people.unresolved,
        };
      }
      const key = JSON.stringify({
        source: 'meeting', query: input.query ?? '',
        organizerNames: input.organizerNames ?? [],
        participantNames: input.participantNames ?? [], range: input.range,
      });
      const continuation = input.cursor ? cursors.get(input.cursor) : undefined;
      const windows = continuation?.kind === 'search'
        && continuation.source === 'meeting'
        && continuation.key === key
        ? continuation.windows
        : splitProviderWindows(input.range, now());
      try {
        const results = await Promise.all(windows.map((window) => service.searchMeetings({
          ...(input.query ? { query: input.query } : {}),
          ...(input.organizerNames?.length
            ? { organizerIds: input.organizerNames.map((name) => people.ids.get(name)!) }
            : {}),
          ...(input.participantNames?.length
            ? { participantIds: input.participantNames.map((name) => people.ids.get(name)!) }
            : {}),
          start: window.start, end: window.end, pageSize: PAGE_SIZE,
          ...(window.pageToken ? { pageToken: window.pageToken } : {}),
        }, abortSignal)));
        const unique = new Map<string, MeetingCandidate>();
        for (const result of results) {
          for (const item of result.items) unique.set(item.meetingId, item);
        }
        const pendingWindows = results.flatMap((result, index) => (
          result.nextPageToken
            ? [{ ...windows[index]!, pageToken: result.nextPageToken }]
            : []
        ));
        const rawCount = results.reduce((sum, result) => sum + result.rawCount, 0);
        const validCount = results.reduce((sum, result) => sum + result.validCount, 0);
        const omittedCount = results.reduce((sum, result) => sum + result.omittedCount, 0);
        let details: Awaited<ReturnType<MeetingService['getMeetingDetails']>> = [];
        let artifactAvailability: 'loaded' | 'unavailable' = 'loaded';
        if (unique.size > 0) {
          try {
            details = await service.getMeetingDetails([...unique.keys()], abortSignal);
          } catch (error) {
            if (isRunTermination(error)) throw error;
            artifactAvailability = 'unavailable';
          }
        }
        audit.record({
          toolName: 'searchMeetings', success: true, rawCount, validCount, omittedCount,
        });
        const detailById = new Map(details.map((detail) => [detail.meetingId, detail]));
        const cursor = pendingWindows.length > 0
          ? nextCursor({ kind: 'search', source: 'meeting', key, windows: pendingWindows })
          : undefined;
        return {
          status: artifactAvailability === 'unavailable'
            || results.some((result) => result.status === 'partial')
            ? 'partial' as const
            : 'complete' as const,
          results: [...unique.values()].map((item) => ({
            meetingRef: referenceFor(item), title: item.title, start: item.start,
            ...(item.end ? { end: item.end } : {}),
            ...(item.url ? { url: item.url } : {}),
            ...(artifactAvailability === 'loaded' ? {
              availableArtifacts: [
                ...(detailById.get(item.meetingId)?.noteId ? ['smart_note' as const] : []),
                ...(detailById.get(item.meetingId)?.minuteToken ? ['minute' as const] : []),
              ],
            } : { artifactAvailability: 'unavailable' as const }),
          })),
          rawCount, validCount, omittedCount,
          ...(cursor ? { nextCursor: cursor } : {}),
        };
      } catch (error) {
        if (isRunTermination(error)) throw error;
        audit.record({
          toolName: 'searchMeetings', success: false,
          errorCategory: error instanceof MeetingContractError
            ? 'meeting_contract_error'
            : 'meeting_search_unavailable',
          ...(error instanceof MeetingContractError ? error.completeness : {}),
        });
        throw error;
      }
    }),
  });

  const searchMeetingMinutes = tool({
    description: [
      'Search independent Feishu Minutes visible to the Dedicated Knowledge User.',
      'Results are discovery metadata; fetch meeting content before using it as evidence.',
    ].join(' '),
    inputSchema: searchMeetingMinutesInputSchema,
    execute: (input, { abortSignal }) => sequential(async () => {
      const names = uniqueNames(input.ownerNames, input.participantNames);
      const people = await resolve(names, abortSignal);
      if (people.ambiguous.length > 0 || people.unresolved.length > 0) {
        const errorCategory = people.ambiguous.length > 0
          ? 'meeting_participant_ambiguous' as const
          : 'meeting_participant_unresolved' as const;
        audit.record({ toolName: 'searchMeetingMinutes', success: false, errorCategory });
        return {
          status: 'needs_clarification' as const,
          ambiguous: people.ambiguous,
          unresolved: people.unresolved,
        };
      }
      const key = JSON.stringify({
        source: 'minute', query: input.query ?? '',
        ownerNames: input.ownerNames ?? [], participantNames: input.participantNames ?? [],
        range: input.range,
      });
      const continuation = input.cursor ? cursors.get(input.cursor) : undefined;
      const windows = continuation?.kind === 'search'
        && continuation.source === 'minute'
        && continuation.key === key
        ? continuation.windows
        : splitProviderWindows(input.range, now());
      try {
        const results = await Promise.all(windows.map((window) => service.searchMinutes({
          ...(input.query ? { query: input.query } : {}),
          ...(input.ownerNames?.length
            ? { ownerIds: input.ownerNames.map((name) => people.ids.get(name)!) }
            : {}),
          ...(input.participantNames?.length
            ? { participantIds: input.participantNames.map((name) => people.ids.get(name)!) }
            : {}),
          start: window.start, end: window.end, pageSize: PAGE_SIZE,
          ...(window.pageToken ? { pageToken: window.pageToken } : {}),
        }, abortSignal)));
        const unique = new Map<string, MinuteCandidate>();
        for (const result of results) {
          for (const item of result.items) unique.set(item.minuteToken, item);
        }
        const pendingWindows = results.flatMap((result, index) => (
          result.nextPageToken
            ? [{ ...windows[index]!, pageToken: result.nextPageToken }]
            : []
        ));
        const rawCount = results.reduce((sum, result) => sum + result.rawCount, 0);
        const validCount = results.reduce((sum, result) => sum + result.validCount, 0);
        const omittedCount = results.reduce((sum, result) => sum + result.omittedCount, 0);
        audit.record({
          toolName: 'searchMeetingMinutes', success: true,
          rawCount, validCount, omittedCount,
        });
        const cursor = pendingWindows.length > 0
          ? nextCursor({ kind: 'search', source: 'minute', key, windows: pendingWindows })
          : undefined;
        return {
          status: results.some((result) => result.status === 'partial')
            ? 'partial' as const
            : 'complete' as const,
          results: [...unique.values()].map((item) => ({
            meetingRef: referenceFor(item), title: item.title,
            ...(item.createdAt ? { createdAt: item.createdAt } : {}),
            ...(item.url ? { url: item.url } : {}),
          })),
          rawCount, validCount, omittedCount,
          ...(cursor ? { nextCursor: cursor } : {}),
        };
      } catch (error) {
        if (isRunTermination(error)) throw error;
        audit.record({
          toolName: 'searchMeetingMinutes', success: false,
          errorCategory: error instanceof MeetingContractError
            ? 'meeting_contract_error'
            : 'meeting_search_unavailable',
          ...(error instanceof MeetingContractError ? error.completeness : {}),
        });
        throw error;
      }
    }),
  });

  const fetchMeetingContent = tool({
    description: [
      'Fetch verified meeting evidence for one meetingRef from this Agent Run.',
      'Prefer readable Feishu AI summaries; use original transcripts only when explicitly needed or no summary is readable.',
      'Start with the five most relevant artifacts; five is not a hard limit.',
    ].join(' '),
    inputSchema: fetchMeetingContentInputSchema,
    execute: (input, { abortSignal }) => sequential(async () => {
      const reference = references.get(input.meetingRef);
      if (!reference) throw new Error('invalid_meeting_reference');
      const key = JSON.stringify([
        input.meetingRef, input.contentKind, input.artifactPreference,
      ]);
      const continuation = input.cursor ? cursors.get(input.cursor) : undefined;
      const pageIndex = continuation?.kind === 'content' && continuation.key === key
        ? continuation.pageIndex
        : 0;
      try {
        let snapshot = snapshots.get(key);
        if (!snapshot) {
          snapshot = await service.fetchContent(reference, {
            contentKind: input.contentKind as MeetingContentRequest,
            artifactPreference: input.artifactPreference as MeetingArtifactPreference,
          }, byteBudget, abortSignal);
          snapshots.set(key, snapshot);
          pages.set(key, paginate(snapshot.text));
        }
        const pageSet = pages.get(key)!;
        const content = pageSet[pageIndex];
        if (content === undefined) throw new Error('invalid_meeting_content_cursor');
        const next = pageIndex + 1 < pageSet.length
          ? nextCursor({ kind: 'content', key, pageIndex: pageIndex + 1 })
          : undefined;
        const url = safeSourceUrl(snapshot.url);
        const source = url ? sources.register({
          title: `[${contentLabel(snapshot.kind)}] ${snapshot.title}${
            snapshot.meetingTime ? ` — ${snapshot.meetingTime}` : ''
          }`,
          url,
        }) : undefined;
        audit.record({
          toolName: 'fetchMeetingContent', success: true,
          fetchedCount: 1, contentKind: snapshot.kind,
        });
        return {
          content,
          contentType: snapshot.kind,
          ...(source ? { source } : { sourceUnavailable: true as const }),
          ...(next ? { nextCursor: next } : {}),
          truncated: next !== undefined,
        };
      } catch (error) {
        if (isRunTermination(error)) throw error;
        audit.record({
          toolName: 'fetchMeetingContent', success: false, fetchedCount: 0,
          errorCategory: error instanceof MeetingContentError
            ? 'meeting_content_unavailable'
            : 'meeting_artifact_unsafe',
        });
        throw error;
      }
    }),
  });

  return { searchMeetings, searchMeetingMinutes, fetchMeetingContent };
}
