import { z } from 'zod';
import {
  LarkCliError,
  LarkContractError,
  MeetingArtifactError,
  MeetingContentError,
  MeetingContractError,
} from './errors.js';
import {
  systemMeetingArtifactStore,
  type MeetingArtifactStore,
  type MeetingByteBudget,
} from './meeting-artifacts.js';
import type { KnowledgeReader } from './knowledge-service.js';
import type { LarkExecutor } from './runner.js';

export type PersonResolution =
  | { status: 'resolved'; name: string; openId: string }
  | { status: 'ambiguous'; name: string; candidates: string[] }
  | { status: 'unresolved'; name: string };

export type MeetingCandidate = {
  kind: 'meeting';
  meetingId: string;
  title: string;
  start?: string;
  end?: string;
  url?: string;
};

export type MinuteCandidate = {
  kind: 'minute';
  minuteToken: string;
  title: string;
  createdAt?: string;
  url?: string;
};

export type DiscoveryPage<T> = {
  status: 'complete' | 'partial';
  items: T[];
  rawCount: number;
  validCount: number;
  omittedCount: number;
  nextPageToken?: string;
};

export type MeetingDetail = {
  meetingId: string;
  title: string;
  start?: string;
  end?: string;
  noteId?: string;
  minuteToken?: string;
};

export type MeetingArtifactReference =
  | {
      kind: 'meeting'; meetingId: string; title: string;
      start?: string; url?: string;
    }
  | {
      kind: 'minute'; minuteToken: string; title: string;
      start?: string; url?: string;
    };

export type MeetingContentRequest = 'auto' | 'summary' | 'todos' | 'chapters' | 'transcript';
export type MeetingArtifactPreference = 'auto' | 'smart_note' | 'minute';
export type MeetingContentKind =
  | 'smart_note_ai_summary'
  | 'minute_ai_summary'
  | 'smart_note_todos'
  | 'minute_todos'
  | 'minute_chapters'
  | 'smart_note_transcript'
  | 'minute_transcript';

export type MeetingContentLoad = {
  status: 'loaded';
  kind: MeetingContentKind;
  title: string;
  meetingTime?: string;
  url?: string;
  text: string;
};

type MeetingAssociations = {
  title: string;
  meetingTime?: string;
  url?: string;
  noteId?: string;
  minuteToken?: string;
};

export type MeetingSearchInput = {
  query?: string;
  start?: string;
  end?: string;
  organizerIds?: string[];
  participantIds?: string[];
  pageToken?: string;
  pageSize: number;
};

export type MinuteSearchInput = {
  query?: string;
  start?: string;
  end?: string;
  ownerIds?: string[];
  participantIds?: string[];
  pageToken?: string;
  pageSize: number;
};

export interface MeetingService {
  resolvePeople(names: string[], signal?: AbortSignal): Promise<PersonResolution[]>;
  searchMeetings(
    input: MeetingSearchInput,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<MeetingCandidate>>;
  getMeetingDetails(meetingIds: string[], signal?: AbortSignal): Promise<MeetingDetail[]>;
  searchMinutes(
    input: MinuteSearchInput,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<MinuteCandidate>>;
  fetchContent(
    reference: MeetingArtifactReference,
    input: {
      contentKind: MeetingContentRequest;
      artifactPreference: MeetingArtifactPreference;
    },
    budget: MeetingByteBudget,
    signal?: AbortSignal,
  ): Promise<MeetingContentLoad>;
}

const contactEnvelopeSchema = z.object({
  users: z.array(z.unknown()),
}).passthrough();

const contactRowSchema = z.object({
  open_id: z.string().min(1),
  localized_name: z.string().min(1),
}).passthrough();

const searchEnvelopeSchema = z.object({
  items: z.array(z.unknown()),
  has_more: z.boolean().optional(),
  page_token: z.string().optional(),
}).passthrough();

const detailEnvelopeSchema = z.object({
  meetings: z.array(z.unknown()),
}).passthrough();

const meetingRowSchema = z.object({
  id: z.string().trim().min(1),
  display_info: z.string().optional(),
  meta_data: z.object({
    app_link: z.unknown().optional(),
    description: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();

const meetingDetailRowSchema = z.object({
  meeting_id: z.string().min(1),
  topic: z.string().min(1),
}).passthrough();

const minuteRowSchema = z.object({
  title: z.string().min(1),
}).passthrough();

const noteDetailSchema = z.object({
  note: z.object({
    note_display_type: z.enum(['normal', 'unified', 'unknown']),
    note_doc_token: z.string().optional(),
    verbatim_doc_token: z.string().optional(),
  }).passthrough(),
}).passthrough();

const minuteDetailEnvelopeSchema = z.object({
  minutes: z.array(z.unknown()),
}).passthrough();

const minuteDetailRowSchema = z.object({
  minute_token: z.string().min(1),
  title: z.string().optional(),
  note_id: z.string().optional(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

function optionalString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function boundedDisplay(value: string, limit = 500) {
  return value.trim().slice(0, limit);
}

function optionalHttpUrl(value: unknown) {
  const candidate = optionalString(value);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function parseEnvelope<TSchema extends z.ZodType>(schema: TSchema, data: unknown) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new MeetingContractError({ rawCount: 0, validCount: 0, omittedCount: 0 });
  }
  return parsed.data;
}

function normalizeRows<T>(rows: unknown[], normalize: (row: unknown) => T | undefined) {
  const items = rows.flatMap((row) => {
    const item = normalize(row);
    return item === undefined ? [] : [item];
  });
  const rawCount = rows.length;
  const omittedCount = rawCount - items.length;
  if (rawCount > 0 && items.length === 0) {
    throw new MeetingContractError({ rawCount, validCount: 0, omittedCount });
  }
  return {
    status: omittedCount === 0 ? 'complete' as const : 'partial' as const,
    items,
    rawCount,
    validCount: items.length,
    omittedCount,
  };
}

function isArtifactLocalFailure(error: unknown) {
  if (
    error instanceof MeetingContentError
    || error instanceof MeetingContractError
    || error instanceof MeetingArtifactError
    || error instanceof LarkContractError
  ) return true;
  return error instanceof LarkCliError && error.code === 'cli_error';
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function renderListArtifact(value: unknown, fields: string[]) {
  if (!Array.isArray(value)) return undefined;
  const lines = value.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [`- ${item.trim()}`];
    const object = recordValue(item);
    if (!object) return [];
    const text = fields.map((field) => optionalString(object[field])).find(Boolean);
    return text ? [`- ${text}`] : [];
  });
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function parseContactCandidates(data: unknown) {
  const envelope = contactEnvelopeSchema.safeParse(data);
  if (!envelope.success) {
    throw new MeetingContractError({ rawCount: 0, validCount: 0, omittedCount: 0 });
  }
  const candidates = envelope.data.users.flatMap((value) => {
    const row = contactRowSchema.safeParse(value);
    return row.success ? [row.data] : [];
  });
  if (envelope.data.users.length > 0 && candidates.length === 0) {
    throw new MeetingContractError({
      rawCount: envelope.data.users.length,
      validCount: 0,
      omittedCount: envelope.data.users.length,
    });
  }
  return candidates;
}

export class LarkMeetingService implements MeetingService {
  constructor(
    private readonly executor: LarkExecutor,
    private readonly knowledge: KnowledgeReader,
    private readonly artifacts: MeetingArtifactStore = systemMeetingArtifactStore(),
  ) {}

  private run<T>(command: Parameters<LarkExecutor['run']>[0], signal?: AbortSignal) {
    return signal ? this.executor.run<T>(command, signal) : this.executor.run<T>(command);
  }

  async resolvePeople(names: string[], signal?: AbortSignal): Promise<PersonResolution[]> {
    const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    return Promise.all(uniqueNames.map(async (name): Promise<PersonResolution> => {
      const data = await this.run<unknown>({
        id: 'contact.searchUser', query: name, pageSize: 30,
      }, signal);
      const matches = parseContactCandidates(data)
        .filter((candidate) => candidate.localized_name === name);
      if (matches.length === 1) {
        return { status: 'resolved', name, openId: matches[0]!.open_id };
      }
      if (matches.length > 1) {
        return {
          status: 'ambiguous',
          name,
          candidates: [...new Set(matches.slice(0, 5).map((candidate) => (
            boundedDisplay(candidate.localized_name, 100)
          )))],
        };
      }
      return { status: 'unresolved', name };
    }));
  }

  async searchMeetings(
    input: MeetingSearchInput,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<MeetingCandidate>> {
    const data = await this.run<unknown>({
      id: 'vc.search',
      ...(input.query ? { query: input.query } : {}),
      ...(input.start ? { start: input.start } : {}),
      ...(input.end ? { end: input.end } : {}),
      ...(input.organizerIds?.length ? { organizerIds: input.organizerIds } : {}),
      ...(input.participantIds?.length ? { participantIds: input.participantIds } : {}),
      pageSize: input.pageSize,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    }, signal);
    const envelope = parseEnvelope(searchEnvelopeSchema, data);
    const normalized = normalizeRows(envelope.items, (raw): MeetingCandidate | undefined => {
      const row = meetingRowSchema.safeParse(raw);
      if (!row.success) return undefined;
      const title = optionalString(row.data.display_info?.trim()) ?? '未命名会议';
      const url = optionalHttpUrl(row.data.meta_data?.app_link);
      return {
        kind: 'meeting',
        meetingId: row.data.id,
        title: boundedDisplay(title),
        ...(url ? { url } : {}),
      };
    });
    const nextPageToken = envelope.has_more ? optionalString(envelope.page_token) : undefined;
    return { ...normalized, ...(nextPageToken ? { nextPageToken } : {}) };
  }

  async getMeetingDetails(meetingIds: string[], signal?: AbortSignal): Promise<MeetingDetail[]> {
    const data = await this.run<unknown>({ id: 'vc.detail', meetingIds }, signal);
    const envelope = parseEnvelope(detailEnvelopeSchema, data);
    return normalizeRows(envelope.meetings, (raw): MeetingDetail | undefined => {
      const row = meetingDetailRowSchema.safeParse(raw);
      if (!row.success) return undefined;
      const start = optionalString(row.data.start_time);
      const end = optionalString(row.data.end_time);
      const noteId = optionalString(row.data.note_id);
      const minuteToken = optionalString(row.data.minute_token);
      return {
        meetingId: row.data.meeting_id,
        title: boundedDisplay(row.data.topic),
        ...(start ? { start } : {}),
        ...(end ? { end } : {}),
        ...(noteId ? { noteId } : {}),
        ...(minuteToken ? { minuteToken } : {}),
      };
    }).items;
  }

  async searchMinutes(
    input: MinuteSearchInput,
    signal?: AbortSignal,
  ): Promise<DiscoveryPage<MinuteCandidate>> {
    const data = await this.run<unknown>({
      id: 'minutes.search',
      ...(input.query ? { query: input.query } : {}),
      ...(input.start ? { start: input.start } : {}),
      ...(input.end ? { end: input.end } : {}),
      ...(input.ownerIds?.length ? { ownerIds: input.ownerIds } : {}),
      ...(input.participantIds?.length ? { participantIds: input.participantIds } : {}),
      pageSize: input.pageSize,
      ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    }, signal);
    const envelope = parseEnvelope(searchEnvelopeSchema, data);
    const normalized = normalizeRows(envelope.items, (raw): MinuteCandidate | undefined => {
      const row = minuteRowSchema.safeParse(raw);
      if (!row.success) return undefined;
      const minuteToken = optionalString(row.data.minute_token) ?? optionalString(row.data.token);
      if (!minuteToken) return undefined;
      const createdAt = optionalString(row.data.create_time ?? row.data.created_at);
      const url = optionalHttpUrl(row.data.url ?? row.data.minute_url);
      return {
        kind: 'minute',
        minuteToken,
        title: boundedDisplay(row.data.title),
        ...(createdAt ? { createdAt } : {}),
        ...(url ? { url } : {}),
      };
    });
    const nextPageToken = envelope.has_more ? optionalString(envelope.page_token) : undefined;
    return { ...normalized, ...(nextPageToken ? { nextPageToken } : {}) };
  }

  private async minuteDetail(
    minuteToken: string,
    artifact: 'basic' | 'summary' | 'todo' | 'chapter',
    signal?: AbortSignal,
  ) {
    const data = await this.run<unknown>({
      id: 'minutes.detail', minuteTokens: [minuteToken], artifact,
    }, signal);
    const envelope = parseEnvelope(minuteDetailEnvelopeSchema, data);
    const row = envelope.minutes
      .map((value) => minuteDetailRowSchema.safeParse(value))
      .find((result) => result.success && result.data.minute_token === minuteToken);
    if (!row?.success) throw new MeetingContentError('meeting_content_unavailable');
    return row.data;
  }

  private async associations(
    reference: MeetingArtifactReference,
    signal?: AbortSignal,
  ): Promise<MeetingAssociations> {
    if (reference.kind === 'meeting') {
      const detail = (await this.getMeetingDetails([reference.meetingId], signal))
        .find((value) => value.meetingId === reference.meetingId);
      if (!detail) throw new MeetingContentError('meeting_content_unavailable');
      const meetingTime = reference.start ?? detail.start;
      return {
        title: reference.title || detail.title,
        ...(meetingTime ? { meetingTime } : {}),
        ...(reference.url ? { url: reference.url } : {}),
        ...(detail.noteId ? { noteId: detail.noteId } : {}),
        ...(detail.minuteToken ? { minuteToken: detail.minuteToken } : {}),
      };
    }
    const detail = await this.minuteDetail(reference.minuteToken, 'basic', signal);
    return {
      title: reference.title || detail.title || 'Minute',
      ...(reference.start ? { meetingTime: reference.start } : {}),
      ...(reference.url ? { url: reference.url } : {}),
      ...(optionalString(detail.note_id) ? { noteId: detail.note_id! } : {}),
      minuteToken: reference.minuteToken,
    };
  }

  private result(
    metadata: { title: string; meetingTime?: string; url?: string },
    kind: MeetingContentKind,
    text: string,
    url?: string,
  ): MeetingContentLoad {
    if (!text.trim()) throw new MeetingContentError('meeting_content_unavailable');
    return {
      status: 'loaded', kind, title: metadata.title,
      ...(metadata.meetingTime ? { meetingTime: metadata.meetingTime } : {}),
      ...((url ?? metadata.url) ? { url: url ?? metadata.url } : {}),
      text,
    };
  }

  private async noteDetail(noteId: string, signal?: AbortSignal) {
    const data = await this.run<unknown>({ id: 'note.detail', noteId }, signal);
    return parseEnvelope(noteDetailSchema, data).note;
  }

  private async smartNoteDocument(
    metadata: { title: string; meetingTime?: string; url?: string },
    noteId: string,
    kind: 'smart_note_ai_summary' | 'smart_note_todos',
    signal?: AbortSignal,
  ) {
    const note = await this.noteDetail(noteId, signal);
    const token = optionalString(note.note_doc_token);
    if (!token) throw new MeetingContentError('meeting_content_unavailable');
    const document = await this.knowledge.fetchDocument({ doc: token }, signal);
    return this.result(metadata, kind, document.markdown, document.url);
  }

  private async smartNoteTranscript(
    metadata: { title: string; meetingTime?: string; url?: string },
    noteId: string,
    budget: MeetingByteBudget,
    signal?: AbortSignal,
  ) {
    const note = await this.noteDetail(noteId, signal);
    if (
      (note.note_display_type === 'normal' || note.note_display_type === 'unknown')
      && optionalString(note.verbatim_doc_token)
    ) {
      const document = await this.knowledge.fetchDocument({
        doc: note.verbatim_doc_token!,
      }, signal);
      return this.result(metadata, 'smart_note_transcript', document.markdown, document.url);
    }
    if (note.note_display_type !== 'unified') {
      throw new MeetingContentError('meeting_transcript_unavailable');
    }
    return this.artifacts.withDirectory(async (workDir) => {
      const data = await this.run<unknown>({
        id: 'note.transcript', noteId, workDir,
      }, signal);
      const response = z.object({ transcript_file: z.string().min(1) }).passthrough()
        .safeParse(data);
      if (!response.success) throw new MeetingContentError('meeting_transcript_unavailable');
      const text = await this.artifacts.readFile(workDir, response.data.transcript_file, budget);
      return this.result(metadata, 'smart_note_transcript', text);
    });
  }

  private async minuteContent(
    metadata: { title: string; meetingTime?: string; url?: string },
    minuteToken: string,
    contentKind: Exclude<MeetingContentRequest, 'auto' | 'transcript'>,
    signal?: AbortSignal,
  ) {
    const artifact = contentKind === 'todos' ? 'todo' : contentKind === 'chapters'
      ? 'chapter'
      : 'summary';
    const detail = await this.minuteDetail(minuteToken, artifact, signal);
    const artifacts = detail.artifacts ?? {};
    if (contentKind === 'summary') {
      const text = optionalString(artifacts.summary);
      if (!text) throw new MeetingContentError('meeting_content_unavailable');
      return this.result(metadata, 'minute_ai_summary', text);
    }
    if (contentKind === 'todos') {
      const text = renderListArtifact(artifacts.todos, ['content', 'title', 'text']);
      if (!text) throw new MeetingContentError('meeting_content_unavailable');
      return this.result(metadata, 'minute_todos', text);
    }
    const text = renderListArtifact(artifacts.chapters, ['title', 'content', 'text']);
    if (!text) throw new MeetingContentError('meeting_content_unavailable');
    return this.result(metadata, 'minute_chapters', text);
  }

  private async minuteTranscript(
    metadata: { title: string; meetingTime?: string; url?: string },
    minuteToken: string,
    budget: MeetingByteBudget,
    signal?: AbortSignal,
  ) {
    return this.artifacts.withDirectory(async (workDir) => {
      const data = await this.run<unknown>({
        id: 'minutes.detail', minuteTokens: [minuteToken], artifact: 'transcript', workDir,
      }, signal);
      const envelope = parseEnvelope(minuteDetailEnvelopeSchema, data);
      const row = envelope.minutes
        .map((value) => minuteDetailRowSchema.safeParse(value))
        .find((result) => result.success && result.data.minute_token === minuteToken);
      const transcriptFile = row?.success
        ? optionalString(row.data.artifacts?.transcript_file)
        : undefined;
      if (!transcriptFile) throw new MeetingContentError('meeting_transcript_unavailable');
      const text = await this.artifacts.readFile(workDir, transcriptFile, budget);
      return this.result(metadata, 'minute_transcript', text);
    });
  }

  async fetchContent(
    reference: MeetingArtifactReference,
    input: {
      contentKind: MeetingContentRequest;
      artifactPreference: MeetingArtifactPreference;
    },
    budget: MeetingByteBudget,
    signal?: AbortSignal,
  ): Promise<MeetingContentLoad> {
    let metadata: {
      title: string; meetingTime?: string; url?: string;
      noteId?: string; minuteToken?: string;
    };
    if (reference.kind === 'minute' && input.artifactPreference === 'minute') {
      metadata = {
        title: reference.title,
        ...(reference.start ? { meetingTime: reference.start } : {}),
        ...(reference.url ? { url: reference.url } : {}),
        minuteToken: reference.minuteToken,
      };
    } else {
      let association: MeetingAssociations;
      try {
        association = await this.associations(reference, signal);
      } catch (error) {
        if (
          reference.kind !== 'minute'
          || input.artifactPreference !== 'auto'
          || !isArtifactLocalFailure(error)
        ) throw error;
        association = {
          title: reference.title,
          ...(reference.start ? { meetingTime: reference.start } : {}),
          ...(reference.url ? { url: reference.url } : {}),
          minuteToken: reference.minuteToken,
        };
      }
      metadata = {
        title: association.title,
        ...(association.meetingTime ? { meetingTime: association.meetingTime } : {}),
        ...(association.url ? { url: association.url } : {}),
        ...(association.noteId ? { noteId: association.noteId } : {}),
        ...(association.minuteToken ? { minuteToken: association.minuteToken } : {}),
      };
    }

    const attempts: Array<() => Promise<MeetingContentLoad>> = [];
    const allowSmart = input.artifactPreference !== 'minute';
    const allowMinute = input.artifactPreference !== 'smart_note';
    if (input.contentKind === 'auto' || input.contentKind === 'summary') {
      if (allowSmart && metadata.noteId) {
        attempts.push(() => this.smartNoteDocument(
          metadata, metadata.noteId!, 'smart_note_ai_summary', signal,
        ));
      }
      if (allowMinute && metadata.minuteToken) {
        attempts.push(() => this.minuteContent(metadata, metadata.minuteToken!, 'summary', signal));
      }
      if (input.contentKind === 'auto') {
        if (allowSmart && metadata.noteId) {
          attempts.push(() => this.smartNoteTranscript(metadata, metadata.noteId!, budget, signal));
        }
        if (allowMinute && metadata.minuteToken) {
          attempts.push(() => this.minuteTranscript(metadata, metadata.minuteToken!, budget, signal));
        }
      }
    } else if (input.contentKind === 'transcript') {
      if (allowSmart && metadata.noteId) {
        attempts.push(() => this.smartNoteTranscript(metadata, metadata.noteId!, budget, signal));
      }
      if (allowMinute && metadata.minuteToken) {
        attempts.push(() => this.minuteTranscript(metadata, metadata.minuteToken!, budget, signal));
      }
    } else if (input.contentKind === 'todos') {
      if (allowSmart && metadata.noteId) {
        attempts.push(() => this.smartNoteDocument(
          metadata, metadata.noteId!, 'smart_note_todos', signal,
        ));
      }
      if (allowMinute && metadata.minuteToken) {
        attempts.push(() => this.minuteContent(metadata, metadata.minuteToken!, 'todos', signal));
      }
    } else if (allowMinute && metadata.minuteToken) {
      attempts.push(() => this.minuteContent(metadata, metadata.minuteToken!, 'chapters', signal));
    }

    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        if (!isArtifactLocalFailure(error)) throw error;
      }
    }
    throw new MeetingContentError(
      input.contentKind === 'transcript'
        ? 'meeting_transcript_unavailable'
        : 'meeting_content_unavailable',
    );
  }
}
