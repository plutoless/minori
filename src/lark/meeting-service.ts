import { z } from 'zod';
import { MeetingContractError } from './errors.js';
import type { LarkExecutor } from './runner.js';

export type PersonResolution =
  | { status: 'resolved'; name: string; openId: string }
  | { status: 'ambiguous'; name: string; candidates: string[] }
  | { status: 'unresolved'; name: string };

export type MeetingCandidate = {
  kind: 'meeting';
  meetingId: string;
  title: string;
  start: string;
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
}

const contactEnvelopeSchema = z.object({
  users: z.array(z.unknown()),
}).passthrough();

const contactRowSchema = z.object({
  open_id: z.string().min(1),
  localized_name: z.string().min(1),
  department: z.string().optional(),
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
  meeting_id: z.string().min(1),
  topic: z.string().min(1),
  start_time: z.string().min(1),
}).passthrough();

const meetingDetailRowSchema = z.object({
  meeting_id: z.string().min(1),
  topic: z.string().min(1),
}).passthrough();

const minuteRowSchema = z.object({
  title: z.string().min(1),
}).passthrough();

function optionalString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

function candidateLabel(name: string, department: string | undefined) {
  const suffix = department?.trim();
  return (suffix ? `${name} / ${suffix}` : name).slice(0, 160);
}

export class LarkMeetingService implements MeetingService {
  constructor(private readonly executor: LarkExecutor) {}

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
          candidates: matches.slice(0, 5).map((candidate) => (
            candidateLabel(candidate.localized_name, candidate.department)
          )),
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
      const end = optionalString(row.data.end_time);
      const url = optionalHttpUrl(row.data.url ?? row.data.meeting_url);
      return {
        kind: 'meeting',
        meetingId: row.data.meeting_id,
        title: row.data.topic,
        start: row.data.start_time,
        ...(end ? { end } : {}),
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
        title: row.data.topic,
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
        title: row.data.title,
        ...(createdAt ? { createdAt } : {}),
        ...(url ? { url } : {}),
      };
    });
    const nextPageToken = envelope.has_more ? optionalString(envelope.page_token) : undefined;
    return { ...normalized, ...(nextPageToken ? { nextPageToken } : {}) };
  }
}
