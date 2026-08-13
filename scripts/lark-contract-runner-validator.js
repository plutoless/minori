// Generated from the owning production service. Do not edit.

// src/lark/runner.ts
import { z } from "zod";

// src/lark/command-catalog.ts
var USER_JSON_ARGS = ["--format", "json", "--as", "user"];
function buildInvocation(command) {
  switch (command.id) {
    case "auth.status":
      return { args: ["auth", "status", "--json", "--verify"] };
    case "contact.searchUser":
      return {
        args: [
          "contact",
          "+search-user",
          "--query",
          command.query,
          "--page-size",
          String(command.pageSize),
          ...USER_JSON_ARGS
        ]
      };
    case "vc.search":
      return {
        args: [
          "vc",
          "+search",
          ...command.query ? ["--query", command.query] : [],
          ...command.start ? ["--start", command.start] : [],
          ...command.end ? ["--end", command.end] : [],
          ...command.organizerIds?.length ? ["--organizer-ids", command.organizerIds.join(",")] : [],
          ...command.participantIds?.length ? ["--participant-ids", command.participantIds.join(",")] : [],
          "--page-size",
          String(command.pageSize),
          ...command.pageToken ? ["--page-token", command.pageToken] : [],
          ...USER_JSON_ARGS
        ]
      };
    case "vc.detail":
      return {
        args: [
          "vc",
          "+detail",
          "--meeting-ids",
          command.meetingIds.join(","),
          ...USER_JSON_ARGS
        ]
      };
    case "note.detail":
      return {
        args: ["note", "+detail", "--note-id", command.noteId, ...USER_JSON_ARGS]
      };
    case "note.transcript":
      return {
        args: [
          "note",
          "+transcript",
          "--note-id",
          command.noteId,
          "--output",
          "unified_transcript.md",
          "--transcript-format",
          "markdown",
          ...USER_JSON_ARGS
        ],
        cwd: command.workDir
      };
    case "minutes.search":
      return {
        args: [
          "minutes",
          "+search",
          ...command.query ? ["--query", command.query] : [],
          ...command.start ? ["--start", command.start] : [],
          ...command.end ? ["--end", command.end] : [],
          ...command.ownerIds?.length ? ["--owner-ids", command.ownerIds.join(",")] : [],
          ...command.participantIds?.length ? ["--participant-ids", command.participantIds.join(",")] : [],
          "--page-size",
          String(command.pageSize),
          ...command.pageToken ? ["--page-token", command.pageToken] : [],
          ...USER_JSON_ARGS
        ]
      };
    case "minutes.detail": {
      return {
        args: [
          "minutes",
          "+detail",
          "--minute-tokens",
          command.minuteTokens.join(","),
          ...command.artifact === "basic" ? [] : [`--${command.artifact}`],
          ...command.artifact === "transcript" ? ["--output-dir", "."] : [],
          ...USER_JSON_ARGS
        ],
        ...command.artifact === "transcript" ? { cwd: command.workDir } : {}
      };
    }
    case "drive.search":
      return {
        args: [
          "drive",
          "+search",
          "--query",
          command.query,
          ...command.spaceIds?.length ? ["--space-ids", command.spaceIds.join(",")] : [],
          ...USER_JSON_ARGS
        ]
      };
    case "docs.fetch":
      return {
        args: [
          "docs",
          "+fetch",
          "--doc",
          command.doc,
          "--doc-format",
          "markdown",
          ...USER_JSON_ARGS
        ]
      };
    case "docs.create":
      return {
        args: [
          "docs",
          "+create",
          "--title",
          command.title,
          ...command.parentToken ? ["--parent-token", command.parentToken] : [],
          "--doc-format",
          "markdown",
          "--content",
          "-",
          ...USER_JSON_ARGS
        ],
        stdin: command.content
      };
    case "docs.append":
      return {
        args: [
          "docs",
          "+update",
          "--doc",
          command.doc,
          "--command",
          "append",
          "--revision-id",
          String(command.revisionId),
          "--doc-format",
          "markdown",
          "--content",
          "-",
          ...USER_JSON_ARGS
        ],
        stdin: command.content
      };
    case "docs.patch":
      return {
        args: [
          "docs",
          "+update",
          "--doc",
          command.doc,
          "--command",
          "str_replace",
          "--pattern",
          command.pattern,
          "--revision-id",
          String(command.revisionId),
          "--doc-format",
          "markdown",
          "--content",
          "-",
          ...USER_JSON_ARGS
        ],
        stdin: command.content
      };
    case "wiki.spaceList":
      return { args: ["wiki", "+space-list", ...USER_JSON_ARGS] };
    case "wiki.nodeList":
      return {
        args: [
          "wiki",
          "+node-list",
          "--space-id",
          command.spaceId,
          ...command.parentNodeToken ? ["--parent-node-token", command.parentNodeToken] : [],
          ...USER_JSON_ARGS
        ]
      };
    case "wiki.nodeGet":
      return {
        args: ["wiki", "+node-get", "--node-token", command.nodeToken, ...USER_JSON_ARGS]
      };
  }
}

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

// src/lark/runner.ts
var larkErrorSchema = z.object({
  type: z.string(),
  subtype: z.string(),
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string(),
  hint: z.string().optional()
}).passthrough();
var larkEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    identity: z.string().optional(),
    data: z.unknown()
  }).passthrough(),
  z.object({
    ok: z.literal(false),
    identity: z.string().optional(),
    error: larkErrorSchema
  }).passthrough()
]);
var authIdentityStatusSchema = z.object({
  status: z.string(),
  available: z.boolean()
}).passthrough();
var authStatusSchema = z.object({
  appId: z.string(),
  brand: z.string(),
  defaultAs: z.string(),
  identity: z.enum(["user", "bot", "none"]),
  identities: z.object({
    user: authIdentityStatusSchema,
    bot: authIdentityStatusSchema
  }).passthrough()
}).passthrough();
function validateAuthStatus(data) {
  const parsed = authStatusSchema.safeParse(data);
  if (!parsed.success) throw new LarkCliError("invalid_envelope");
  return parsed.data;
}
var ABORT_KILL_GRACE_MS = 1e3;
var CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
];
function buildChildEnvironment(configDir) {
  const environment = {
    LARKSUITE_CLI_CONFIG_DIR: configDir
  };
  const dataDir = process.env.LARKSUITE_CLI_DATA_DIR;
  if (dataDir !== void 0) environment.LARKSUITE_CLI_DATA_DIR = dataDir;
  for (const key of CHILD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== void 0) environment[key] = value;
  }
  return environment;
}
var LarkRunner = class {
  constructor(options) {
    this.options = options;
  }
  options;
  async run(command, signal) {
    const startedAt = Date.now();
    try {
      const data = await this.execute(command, signal);
      this.recordExecution({
        commandId: command.id,
        outcome: "success",
        durationMs: Date.now() - startedAt
      });
      return data;
    } catch (error) {
      this.recordExecution({
        commandId: command.id,
        outcome: error instanceof LarkCliError ? error.code : "unexpected_error",
        durationMs: Date.now() - startedAt
      });
      throw error;
    }
  }
  async execute(command, signal) {
    const invocation = buildInvocation(command);
    let child;
    try {
      child = this.options.spawn(this.options.binary, invocation.args, {
        shell: false,
        ...invocation.cwd ? { cwd: invocation.cwd } : {},
        env: buildChildEnvironment(this.options.configDir),
        stdio: [invocation.stdin === void 0 ? "ignore" : "pipe", "pipe", "pipe"]
      });
    } catch {
      throw new LarkCliError("spawn_failed");
    }
    if (invocation.stdin !== void 0) {
      if (!child.stdin) {
        child.kill("SIGKILL");
        throw new LarkCliError("spawn_failed");
      }
      child.stdin.on("error", () => void 0);
      try {
        child.stdin.end(invocation.stdin);
      } catch {
        child.kill("SIGKILL");
        throw new LarkCliError("spawn_failed");
      }
    }
    const stdout = [];
    const stderr = [];
    let size = 0;
    let terminationReason;
    let abortKillTimer;
    const terminate = (reason, killSignal) => {
      if (terminationReason) return;
      terminationReason = reason;
      child.kill(killSignal);
    };
    const collect = (target) => (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > this.options.maxOutputBytes) {
        terminate("output_limit", "SIGKILL");
      } else {
        target.push(buffer);
      }
    };
    const collectStdout = collect(stdout);
    const collectStderr = collect(stderr);
    child.stdout.on("data", collectStdout);
    child.stderr.on("data", collectStderr);
    const timer = setTimeout(
      () => terminate("timeout", "SIGKILL"),
      this.options.timeoutMs
    );
    timer.unref?.();
    const onAbort = () => {
      if (terminationReason) return;
      terminationReason = "aborted";
      child.kill("SIGTERM");
      abortKillTimer = setTimeout(() => child.kill("SIGKILL"), ABORT_KILL_GRACE_MS);
      abortKillTimer.unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    let onClose;
    let onSpawnError;
    const outcome = await new Promise((resolve) => {
      onClose = (exitCode2) => resolve({ type: "close", exitCode: exitCode2 });
      onSpawnError = () => resolve({ type: "error" });
      child.once("close", onClose);
      child.once("error", onSpawnError);
    });
    clearTimeout(timer);
    if (abortKillTimer) clearTimeout(abortKillTimer);
    signal?.removeEventListener("abort", onAbort);
    child.removeListener("close", onClose);
    child.removeListener("error", onSpawnError);
    child.stdout.removeListener("data", collectStdout);
    child.stderr.removeListener("data", collectStderr);
    if (terminationReason) throw new LarkCliError(terminationReason);
    if (outcome.type === "error") throw new LarkCliError("spawn_failed");
    const { exitCode } = outcome;
    const output = Buffer.concat(stdout.length > 0 ? stdout : stderr).toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new LarkCliError("malformed_json", { exitCode });
    }
    if (command.id === "auth.status" && exitCode === 0) {
      try {
        return validateAuthStatus(parsed);
      } catch {
        throw new LarkCliError("invalid_envelope", { exitCode });
      }
    }
    const envelope = larkEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) throw new LarkCliError("invalid_envelope", { exitCode });
    if (!envelope.data.ok) throw LarkCliError.fromEnvelope(envelope.data.error, exitCode);
    if (exitCode !== 0) throw new LarkCliError("cli_error", { exitCode });
    return envelope.data.data;
  }
  recordExecution(metadata) {
    try {
      this.options.onExecution?.(metadata);
    } catch {
    }
  }
};
export {
  LarkRunner,
  validateAuthStatus
};
