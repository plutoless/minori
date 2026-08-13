// Generated from the owning production service. Do not edit.

// src/lark/meeting-service.ts
import { z } from "zod";

// src/lark/errors.ts
var LarkCliError = class _LarkCliError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
    this.name = "LarkCliError";
  }
  code;
  details;
  static fromEnvelope(error, exitCode) {
    return new _LarkCliError("cli_error", {
      exitCode,
      ...error.type ? { type: error.type } : {},
      ...error.subtype ? { subtype: error.subtype } : {},
      ...error.code !== void 0 ? { upstreamCode: error.code } : {}
    });
  }
};
var LarkContractError = class extends Error {
  code = "contract_error";
  constructor() {
    super("contract_error");
    this.name = "LarkContractError";
  }
};
var MeetingContractError = class extends Error {
  constructor(completeness) {
    super("meeting_contract_error");
    this.completeness = completeness;
    this.name = "MeetingContractError";
  }
  completeness;
  code = "meeting_contract_error";
};
var MeetingArtifactError = class extends Error {
  code = "meeting_artifact_unsafe";
  constructor() {
    super("meeting_artifact_unsafe");
    this.name = "MeetingArtifactError";
  }
};
var MeetingContentError = class extends Error {
  constructor(code) {
    super(code);
    this.code = code;
    this.name = "MeetingContentError";
  }
  code;
};

// src/lark/meeting-artifacts.ts
import { constants } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
var MAX_MEETING_FILE_BYTES = 8 * 1024 * 1024;
var MAX_MEETING_RUN_BYTES = 24 * 1024 * 1024;
function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
async function requirePlainPath(root, candidate) {
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new MeetingArtifactError();
  const path = relative(root, candidate);
  if (!isContained(root, candidate)) throw new MeetingArtifactError();
  let current = root;
  for (const component of path.split(sep)) {
    if (!component || component === "." || component === "..") throw new MeetingArtifactError();
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new MeetingArtifactError();
  }
}
function systemMeetingArtifactStore(options = {}) {
  return {
    async withDirectory(operation) {
      let directory;
      try {
        const root = await realpath(options.temporaryRoot ?? tmpdir());
        const rootInfo = await lstat(root);
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new MeetingArtifactError();
        directory = await mkdtemp(join(root, "minori-meeting-"));
        await chmod(directory, 448);
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 511) !== 448) {
          throw new MeetingArtifactError();
        }
      } catch (error) {
        if (directory) await rm(directory, { recursive: true, force: true }).catch(() => void 0);
        if (error instanceof MeetingArtifactError) throw error;
        throw new MeetingArtifactError();
      }
      let result;
      let operationError;
      let operationFailed = false;
      try {
        result = await operation(directory);
      } catch (error) {
        operationFailed = true;
        operationError = error;
      }
      try {
        await (options.removeDirectory ? options.removeDirectory(directory) : rm(directory, { recursive: true, force: true }));
      } catch {
        if (!operationFailed) throw new MeetingArtifactError();
      }
      if (operationFailed) throw operationError;
      return result;
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
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          budget.remaining -= bytes.byteLength;
          return text;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof MeetingArtifactError) throw error;
        throw new MeetingArtifactError();
      }
    }
  };
}

// src/lark/meeting-service.ts
var contactEnvelopeSchema = z.object({
  users: z.array(z.unknown())
}).passthrough();
var contactRowSchema = z.object({
  open_id: z.string().min(1),
  localized_name: z.string().min(1)
}).passthrough();
var searchEnvelopeSchema = z.object({
  items: z.array(z.unknown()),
  has_more: z.boolean().optional(),
  page_token: z.string().optional()
}).passthrough();
var detailEnvelopeSchema = z.object({
  meetings: z.array(z.unknown())
}).passthrough();
var meetingRowSchema = z.object({
  id: z.string().trim().min(1),
  display_info: z.string().optional(),
  meta_data: z.object({
    app_link: z.unknown().optional(),
    description: z.unknown().optional()
  }).passthrough().optional()
}).passthrough();
var meetingDetailRowSchema = z.object({
  meeting_id: z.string().min(1),
  topic: z.string().min(1)
}).passthrough();
var minuteRowSchema = z.object({
  title: z.string().min(1)
}).passthrough();
var noteDetailSchema = z.object({
  note: z.object({
    note_display_type: z.enum(["normal", "unified", "unknown"]),
    note_doc_token: z.string().optional(),
    verbatim_doc_token: z.string().optional()
  }).passthrough()
}).passthrough();
var minuteDetailEnvelopeSchema = z.object({
  minutes: z.array(z.unknown())
}).passthrough();
var minuteDetailRowSchema = z.object({
  minute_token: z.string().min(1),
  title: z.string().optional(),
  note_id: z.string().optional(),
  artifacts: z.record(z.string(), z.unknown()).optional()
}).passthrough();
function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function boundedDisplay(value, limit = 500) {
  return value.trim().slice(0, limit);
}
function optionalHttpUrl(value) {
  const candidate = optionalString(value);
  if (!candidate) return void 0;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? candidate : void 0;
  } catch {
    return void 0;
  }
}
function parseEnvelope(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new MeetingContractError({ rawCount: 0, validCount: 0, omittedCount: 0 });
  }
  return parsed.data;
}
function normalizeRows(rows, normalize) {
  const items = rows.flatMap((row) => {
    const item = normalize(row);
    return item === void 0 ? [] : [item];
  });
  const rawCount = rows.length;
  const omittedCount = rawCount - items.length;
  if (rawCount > 0 && items.length === 0) {
    throw new MeetingContractError({ rawCount, validCount: 0, omittedCount });
  }
  return {
    status: omittedCount === 0 ? "complete" : "partial",
    items,
    rawCount,
    validCount: items.length,
    omittedCount
  };
}
function isArtifactLocalFailure(error) {
  if (error instanceof MeetingContentError || error instanceof MeetingContractError || error instanceof MeetingArtifactError || error instanceof LarkContractError) return true;
  return error instanceof LarkCliError && error.code === "cli_error";
}
function recordValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function renderListArtifact(value, fields) {
  if (!Array.isArray(value)) return void 0;
  const lines = value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [`- ${item.trim()}`];
    const object = recordValue(item);
    if (!object) return [];
    const text = fields.map((field) => optionalString(object[field])).find(Boolean);
    return text ? [`- ${text}`] : [];
  });
  return lines.length > 0 ? lines.join("\n") : void 0;
}
function parseContactCandidates(data) {
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
      omittedCount: envelope.data.users.length
    });
  }
  return candidates;
}
function validateMeetingCommandResult(command, data) {
  switch (command) {
    case "contact.searchUser":
      return parseContactCandidates(data);
    case "vc.search": {
      const parsed = parseEnvelope(searchEnvelopeSchema, data);
      normalizeRows(parsed.items, (row) => meetingRowSchema.safeParse(row).success ? row : void 0);
      return parsed;
    }
    case "minutes.search": {
      const parsed = parseEnvelope(searchEnvelopeSchema, data);
      normalizeRows(parsed.items, (row) => minuteRowSchema.safeParse(row).success ? row : void 0);
      return parsed;
    }
    case "vc.detail": {
      const parsed = parseEnvelope(detailEnvelopeSchema, data);
      normalizeRows(parsed.meetings, (row) => meetingDetailRowSchema.safeParse(row).success ? row : void 0);
      return parsed;
    }
    case "note.detail":
      return parseEnvelope(noteDetailSchema, data);
    case "note.transcript": {
      const parsed = z.object({ transcript_file: z.string().min(1) }).passthrough().safeParse(data);
      if (!parsed.success) {
        throw new MeetingContractError({ rawCount: 0, validCount: 0, omittedCount: 0 });
      }
      return parsed.data;
    }
    case "minutes.detail": {
      const parsed = parseEnvelope(minuteDetailEnvelopeSchema, data);
      normalizeRows(parsed.minutes, (row) => minuteDetailRowSchema.safeParse(row).success ? row : void 0);
      return parsed;
    }
  }
}
var LarkMeetingService = class {
  constructor(executor, knowledge, artifacts = systemMeetingArtifactStore()) {
    this.executor = executor;
    this.knowledge = knowledge;
    this.artifacts = artifacts;
  }
  executor;
  knowledge;
  artifacts;
  run(command, signal) {
    return signal ? this.executor.run(command, signal) : this.executor.run(command);
  }
  async resolvePeople(names, signal) {
    const uniqueNames = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    return Promise.all(uniqueNames.map(async (name) => {
      const data = await this.run({
        id: "contact.searchUser",
        query: name,
        pageSize: 30
      }, signal);
      const matches = parseContactCandidates(data).filter((candidate) => candidate.localized_name === name);
      if (matches.length === 1) {
        return { status: "resolved", name, openId: matches[0].open_id };
      }
      if (matches.length > 1) {
        return {
          status: "ambiguous",
          name,
          candidates: [...new Set(matches.slice(0, 5).map((candidate) => boundedDisplay(candidate.localized_name, 100)))]
        };
      }
      return { status: "unresolved", name };
    }));
  }
  async searchMeetings(input, signal) {
    const data = await this.run({
      id: "vc.search",
      ...input.query ? { query: input.query } : {},
      ...input.start ? { start: input.start } : {},
      ...input.end ? { end: input.end } : {},
      ...input.organizerIds?.length ? { organizerIds: input.organizerIds } : {},
      ...input.participantIds?.length ? { participantIds: input.participantIds } : {},
      pageSize: input.pageSize,
      ...input.pageToken ? { pageToken: input.pageToken } : {}
    }, signal);
    const envelope = parseEnvelope(searchEnvelopeSchema, data);
    const normalized = normalizeRows(envelope.items, (raw) => {
      const row = meetingRowSchema.safeParse(raw);
      if (!row.success) return void 0;
      const title = optionalString(row.data.display_info?.trim()) ?? "\u672A\u547D\u540D\u4F1A\u8BAE";
      const url = optionalHttpUrl(row.data.meta_data?.app_link);
      return {
        kind: "meeting",
        meetingId: row.data.id,
        title: boundedDisplay(title),
        ...url ? { url } : {}
      };
    });
    const nextPageToken = envelope.has_more ? optionalString(envelope.page_token) : void 0;
    return { ...normalized, ...nextPageToken ? { nextPageToken } : {} };
  }
  async getMeetingDetails(meetingIds, signal) {
    const data = await this.run({ id: "vc.detail", meetingIds }, signal);
    const envelope = parseEnvelope(detailEnvelopeSchema, data);
    return normalizeRows(envelope.meetings, (raw) => {
      const row = meetingDetailRowSchema.safeParse(raw);
      if (!row.success) return void 0;
      const start = optionalString(row.data.start_time);
      const end = optionalString(row.data.end_time);
      const noteId = optionalString(row.data.note_id);
      const minuteToken = optionalString(row.data.minute_token);
      return {
        meetingId: row.data.meeting_id,
        title: boundedDisplay(row.data.topic),
        ...start ? { start } : {},
        ...end ? { end } : {},
        ...noteId ? { noteId } : {},
        ...minuteToken ? { minuteToken } : {}
      };
    }).items;
  }
  async searchMinutes(input, signal) {
    const data = await this.run({
      id: "minutes.search",
      ...input.query ? { query: input.query } : {},
      ...input.start ? { start: input.start } : {},
      ...input.end ? { end: input.end } : {},
      ...input.ownerIds?.length ? { ownerIds: input.ownerIds } : {},
      ...input.participantIds?.length ? { participantIds: input.participantIds } : {},
      pageSize: input.pageSize,
      ...input.pageToken ? { pageToken: input.pageToken } : {}
    }, signal);
    const envelope = parseEnvelope(searchEnvelopeSchema, data);
    const normalized = normalizeRows(envelope.items, (raw) => {
      const row = minuteRowSchema.safeParse(raw);
      if (!row.success) return void 0;
      const minuteToken = optionalString(row.data.minute_token) ?? optionalString(row.data.token);
      if (!minuteToken) return void 0;
      const createdAt = optionalString(row.data.create_time ?? row.data.created_at);
      const url = optionalHttpUrl(row.data.url ?? row.data.minute_url);
      return {
        kind: "minute",
        minuteToken,
        title: boundedDisplay(row.data.title),
        ...createdAt ? { createdAt } : {},
        ...url ? { url } : {}
      };
    });
    const nextPageToken = envelope.has_more ? optionalString(envelope.page_token) : void 0;
    return { ...normalized, ...nextPageToken ? { nextPageToken } : {} };
  }
  async minuteDetail(minuteToken, artifact, signal) {
    const data = await this.run({
      id: "minutes.detail",
      minuteTokens: [minuteToken],
      artifact
    }, signal);
    const envelope = parseEnvelope(minuteDetailEnvelopeSchema, data);
    const row = envelope.minutes.map((value) => minuteDetailRowSchema.safeParse(value)).find((result) => result.success && result.data.minute_token === minuteToken);
    if (!row?.success) throw new MeetingContentError("meeting_content_unavailable");
    return row.data;
  }
  async associations(reference, signal) {
    if (reference.kind === "meeting") {
      const detail2 = (await this.getMeetingDetails([reference.meetingId], signal)).find((value) => value.meetingId === reference.meetingId);
      if (!detail2) throw new MeetingContentError("meeting_content_unavailable");
      const meetingTime = reference.start ?? detail2.start;
      return {
        title: reference.title || detail2.title,
        ...meetingTime ? { meetingTime } : {},
        ...reference.url ? { url: reference.url } : {},
        ...detail2.noteId ? { noteId: detail2.noteId } : {},
        ...detail2.minuteToken ? { minuteToken: detail2.minuteToken } : {}
      };
    }
    const detail = await this.minuteDetail(reference.minuteToken, "basic", signal);
    return {
      title: reference.title || detail.title || "Minute",
      ...reference.start ? { meetingTime: reference.start } : {},
      ...reference.url ? { url: reference.url } : {},
      ...optionalString(detail.note_id) ? { noteId: detail.note_id } : {},
      minuteToken: reference.minuteToken
    };
  }
  result(metadata, kind, text, url) {
    if (!text.trim()) throw new MeetingContentError("meeting_content_unavailable");
    return {
      status: "loaded",
      kind,
      title: metadata.title,
      ...metadata.meetingTime ? { meetingTime: metadata.meetingTime } : {},
      ...url ?? metadata.url ? { url: url ?? metadata.url } : {},
      text
    };
  }
  async noteDetail(noteId, signal) {
    const data = await this.run({ id: "note.detail", noteId }, signal);
    return parseEnvelope(noteDetailSchema, data).note;
  }
  async smartNoteDocument(metadata, noteId, kind, signal) {
    const note = await this.noteDetail(noteId, signal);
    const token = optionalString(note.note_doc_token);
    if (!token) throw new MeetingContentError("meeting_content_unavailable");
    const document = await this.knowledge.fetchDocument({ doc: token }, signal);
    return this.result(metadata, kind, document.markdown, document.url);
  }
  async smartNoteTranscript(metadata, noteId, budget, signal) {
    const note = await this.noteDetail(noteId, signal);
    if ((note.note_display_type === "normal" || note.note_display_type === "unknown") && optionalString(note.verbatim_doc_token)) {
      const document = await this.knowledge.fetchDocument({
        doc: note.verbatim_doc_token
      }, signal);
      return this.result(metadata, "smart_note_transcript", document.markdown, document.url);
    }
    if (note.note_display_type !== "unified") {
      throw new MeetingContentError("meeting_transcript_unavailable");
    }
    return this.artifacts.withDirectory(async (workDir) => {
      const data = await this.run({
        id: "note.transcript",
        noteId,
        workDir
      }, signal);
      const response = z.object({ transcript_file: z.string().min(1) }).passthrough().safeParse(data);
      if (!response.success) throw new MeetingContentError("meeting_transcript_unavailable");
      const text = await this.artifacts.readFile(workDir, response.data.transcript_file, budget);
      return this.result(metadata, "smart_note_transcript", text);
    });
  }
  async minuteContent(metadata, minuteToken, contentKind, signal) {
    const artifact = contentKind === "todos" ? "todo" : contentKind === "chapters" ? "chapter" : "summary";
    const detail = await this.minuteDetail(minuteToken, artifact, signal);
    const artifacts = detail.artifacts ?? {};
    if (contentKind === "summary") {
      const text2 = optionalString(artifacts.summary);
      if (!text2) throw new MeetingContentError("meeting_content_unavailable");
      return this.result(metadata, "minute_ai_summary", text2);
    }
    if (contentKind === "todos") {
      const text2 = renderListArtifact(artifacts.todos, ["content", "title", "text"]);
      if (!text2) throw new MeetingContentError("meeting_content_unavailable");
      return this.result(metadata, "minute_todos", text2);
    }
    const text = renderListArtifact(artifacts.chapters, ["title", "content", "text"]);
    if (!text) throw new MeetingContentError("meeting_content_unavailable");
    return this.result(metadata, "minute_chapters", text);
  }
  async minuteTranscript(metadata, minuteToken, budget, signal) {
    return this.artifacts.withDirectory(async (workDir) => {
      const data = await this.run({
        id: "minutes.detail",
        minuteTokens: [minuteToken],
        artifact: "transcript",
        workDir
      }, signal);
      const envelope = parseEnvelope(minuteDetailEnvelopeSchema, data);
      const row = envelope.minutes.map((value) => minuteDetailRowSchema.safeParse(value)).find((result) => result.success && result.data.minute_token === minuteToken);
      const transcriptFile = row?.success ? optionalString(row.data.artifacts?.transcript_file) : void 0;
      if (!transcriptFile) throw new MeetingContentError("meeting_transcript_unavailable");
      const text = await this.artifacts.readFile(workDir, transcriptFile, budget);
      return this.result(metadata, "minute_transcript", text);
    });
  }
  async fetchContent(reference, input, budget, signal) {
    let metadata;
    if (reference.kind === "minute" && input.artifactPreference === "minute") {
      metadata = {
        title: reference.title,
        ...reference.start ? { meetingTime: reference.start } : {},
        ...reference.url ? { url: reference.url } : {},
        minuteToken: reference.minuteToken
      };
    } else {
      let association;
      try {
        association = await this.associations(reference, signal);
      } catch (error) {
        if (reference.kind !== "minute" || input.artifactPreference !== "auto" || !isArtifactLocalFailure(error)) throw error;
        association = {
          title: reference.title,
          ...reference.start ? { meetingTime: reference.start } : {},
          ...reference.url ? { url: reference.url } : {},
          minuteToken: reference.minuteToken
        };
      }
      metadata = {
        title: association.title,
        ...association.meetingTime ? { meetingTime: association.meetingTime } : {},
        ...association.url ? { url: association.url } : {},
        ...association.noteId ? { noteId: association.noteId } : {},
        ...association.minuteToken ? { minuteToken: association.minuteToken } : {}
      };
    }
    const attempts = [];
    const allowSmart = input.artifactPreference !== "minute";
    const allowMinute = input.artifactPreference !== "smart_note";
    if (input.contentKind === "auto" || input.contentKind === "summary") {
      if (allowSmart && metadata.noteId) {
        attempts.push(() => this.smartNoteDocument(
          metadata,
          metadata.noteId,
          "smart_note_ai_summary",
          signal
        ));
      }
      if (allowMinute && metadata.minuteToken) {
        attempts.push(() => this.minuteContent(metadata, metadata.minuteToken, "summary", signal));
      }
      if (input.contentKind === "auto") {
        if (allowSmart && metadata.noteId) {
          attempts.push(() => this.smartNoteTranscript(metadata, metadata.noteId, budget, signal));
        }
        if (allowMinute && metadata.minuteToken) {
          attempts.push(() => this.minuteTranscript(metadata, metadata.minuteToken, budget, signal));
        }
      }
    } else if (input.contentKind === "transcript") {
      if (allowSmart && metadata.noteId) {
        attempts.push(() => this.smartNoteTranscript(metadata, metadata.noteId, budget, signal));
      }
      if (allowMinute && metadata.minuteToken) {
        attempts.push(() => this.minuteTranscript(metadata, metadata.minuteToken, budget, signal));
      }
    } else if (input.contentKind === "todos") {
      if (allowSmart && metadata.noteId) {
        attempts.push(() => this.smartNoteDocument(
          metadata,
          metadata.noteId,
          "smart_note_todos",
          signal
        ));
      }
      if (allowMinute && metadata.minuteToken) {
        attempts.push(() => this.minuteContent(metadata, metadata.minuteToken, "todos", signal));
      }
    } else if (allowMinute && metadata.minuteToken) {
      attempts.push(() => this.minuteContent(metadata, metadata.minuteToken, "chapters", signal));
    }
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        if (!isArtifactLocalFailure(error)) throw error;
      }
    }
    throw new MeetingContentError(
      input.contentKind === "transcript" ? "meeting_transcript_unavailable" : "meeting_content_unavailable"
    );
  }
};
export {
  LarkMeetingService,
  validateMeetingCommandResult
};
