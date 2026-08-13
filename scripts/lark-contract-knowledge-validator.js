// Generated from the owning production service. Do not edit.

// src/lark/knowledge-service.ts
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
var KnowledgeSearchContractError = class extends Error {
  constructor(completeness) {
    super("knowledge_search_contract_error");
    this.completeness = completeness;
    this.name = "KnowledgeSearchContractError";
  }
  completeness;
  code = "knowledge_search_contract_error";
};
var KnowledgeWriteConflict = class extends Error {
  code = "knowledge_write_conflict";
  constructor() {
    super("knowledge_write_conflict");
    this.name = "KnowledgeWriteConflict";
  }
};

// src/lark/knowledge-service.ts
var driveSearchSchema = z.object({
  results: z.array(z.unknown())
}).passthrough();
var driveSearchRowSchema = z.object({
  entity_type: z.string().min(1)
}).passthrough();
var documentSchema = z.object({
  document: z.object({
    document_id: z.string(),
    revision_id: z.number().int(),
    content: z.string(),
    title: z.string().optional(),
    url: z.string().optional()
  }).passthrough()
}).passthrough();
var writeResultSchema = z.object({
  document: z.object({
    document_id: z.string().optional(),
    revision_id: z.number().int()
  }).passthrough()
}).passthrough();
var spaceListSchema = z.object({
  spaces: z.array(z.object({
    space_id: z.string(),
    name: z.string()
  }).passthrough())
}).passthrough();
var nodeListSchema = z.object({
  nodes: z.array(z.object({
    node_token: z.string(),
    title: z.string(),
    obj_type: z.string()
  }).passthrough())
}).passthrough();
var nodeSchema = z.object({
  node_token: z.string(),
  obj_token: z.string(),
  obj_type: z.string(),
  title: z.string()
}).passthrough();
function parseContract(schema, data) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new LarkContractError();
  return parsed.data;
}
function validateKnowledgeCommandResult(command, data) {
  switch (command) {
    case "drive.search": {
      const parsed = parseContract(driveSearchSchema, data);
      if (parsed.results.length > 0 && !parsed.results.some((row) => driveSearchRowSchema.safeParse(row).success)) {
        throw new LarkContractError();
      }
      return parsed;
    }
    case "docs.fetch":
      return parseContract(documentSchema, data);
    case "docs.create": {
      const result = parseContract(writeResultSchema, data);
      if (!result.document.document_id) throw new LarkContractError();
      return result;
    }
    case "docs.append":
    case "docs.patch":
      return parseContract(writeResultSchema, data);
    case "wiki.spaceList":
      return parseContract(spaceListSchema, data);
    case "wiki.nodeList":
      return parseContract(nodeListSchema, data);
    case "wiki.nodeGet":
      return parseContract(nodeSchema, data);
  }
}
function titleFromMarkdown(markdown, fallback) {
  return markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() || fallback;
}
function searchResultTitle(title, titleHighlighted, fallback) {
  const highlighted = titleHighlighted?.replace(/<\/?h(?:b)?>/gu, "");
  return title || highlighted || fallback;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function objectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function httpUrl(value) {
  if (typeof value !== "string") return void 0;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : void 0;
  } catch {
    return void 0;
  }
}
function countExactOccurrences(markdown, pattern) {
  if (!pattern) return 0;
  let count = 0;
  let index = 0;
  while (index <= markdown.length - pattern.length) {
    const foundAt = markdown.indexOf(pattern, index);
    if (foundAt === -1) break;
    count += 1;
    index = foundAt + pattern.length;
  }
  return count;
}
function isRevisionConflict(error) {
  if (!(error instanceof LarkCliError) || error.code !== "cli_error") return false;
  if (error.details.upstreamCode === 177003) return true;
  const details = [error.details.type, error.details.subtype, error.details.upstreamCode].filter((value) => typeof value === "string").join(" ");
  return /revision[ _-]?conflict|conflict[ _-]?revision/iu.test(details);
}
var LarkKnowledgeService = class {
  constructor(executor) {
    this.executor = executor;
  }
  executor;
  run(command, signal) {
    return signal ? this.executor.run(command, signal) : this.executor.run(command);
  }
  async search(input, signal) {
    const data = await this.run({
      id: "drive.search",
      query: input.query,
      ...input.spaceIds ? { spaceIds: input.spaceIds } : {}
    }, signal);
    const parsed = parseContract(driveSearchSchema, data);
    const results = parsed.results.flatMap((raw) => {
      const row = driveSearchRowSchema.safeParse(raw);
      if (!row.success) return [];
      const resultMeta = objectValue(row.data.result_meta);
      const token = nonEmptyString(resultMeta?.token) ?? nonEmptyString(row.data.entity_id);
      if (!token) return [];
      const url = httpUrl(resultMeta?.url);
      return [{
        title: searchResultTitle(
          nonEmptyString(row.data.title),
          nonEmptyString(row.data.title_highlighted),
          token
        ),
        ...url ? { url } : {},
        token,
        type: row.data.entity_type
      }];
    });
    const rawCount = parsed.results.length;
    const omittedCount = rawCount - results.length;
    if (rawCount > 0 && results.length === 0) {
      throw new KnowledgeSearchContractError({
        rawCount,
        validCount: 0,
        omittedCount
      });
    }
    return {
      status: omittedCount === 0 ? "complete" : "partial",
      results,
      rawCount,
      validCount: results.length,
      omittedCount
    };
  }
  async fetchDocument(input, signal) {
    const data = await this.run({ id: "docs.fetch", doc: input.doc }, signal);
    const { document } = parseContract(documentSchema, data);
    return {
      token: document.document_id,
      title: document.title ?? titleFromMarkdown(document.content, document.document_id),
      url: document.url ?? (/^https?:\/\//u.test(input.doc) ? input.doc : `https://www.feishu.cn/docx/${encodeURIComponent(document.document_id)}`),
      markdown: document.content,
      revisionId: document.revision_id
    };
  }
  async requireWriteResponse(command, signal) {
    try {
      const data = await this.run(command, signal);
      return parseContract(writeResultSchema, data).document;
    } catch (error) {
      if (isRevisionConflict(error)) throw new KnowledgeWriteConflict();
      throw error;
    }
  }
  async writeResult(operation, token, acceptedRevisionId, signal) {
    const document = await this.fetchDocument({ doc: token }, signal);
    if (document.token !== token || document.revisionId < acceptedRevisionId) {
      throw new LarkContractError();
    }
    return {
      operation,
      token: document.token,
      title: document.title,
      url: document.url,
      revisionId: document.revisionId
    };
  }
  validateWriteResponse(result, token, previousRevisionId) {
    if (result.document_id !== void 0 && result.document_id !== token || result.revision_id <= previousRevisionId) {
      throw new LarkContractError();
    }
  }
  async createDocument(input, signal) {
    const result = await this.requireWriteResponse({
      id: "docs.create",
      title: input.title,
      content: input.content,
      ...input.parentToken ? { parentToken: input.parentToken } : {}
    }, signal);
    if (!result.document_id) throw new LarkContractError();
    return this.writeResult("create", result.document_id, result.revision_id, signal);
  }
  async appendDocument(input, signal) {
    const current = await this.fetchDocument({ doc: input.doc }, signal);
    const result = await this.requireWriteResponse({
      id: "docs.append",
      doc: current.token,
      content: input.content,
      revisionId: current.revisionId
    }, signal);
    this.validateWriteResponse(result, current.token, current.revisionId);
    return this.writeResult("append", current.token, result.revision_id, signal);
  }
  async patchDocument(input, signal) {
    const current = await this.fetchDocument({ doc: input.doc }, signal);
    if (input.expectedRevision !== void 0 && current.revisionId !== input.expectedRevision) {
      throw new KnowledgeWriteConflict();
    }
    if (countExactOccurrences(current.markdown, input.pattern) !== 1) {
      throw new KnowledgeWriteConflict();
    }
    const result = await this.requireWriteResponse({
      id: "docs.patch",
      doc: current.token,
      pattern: input.pattern,
      content: input.replacement,
      revisionId: current.revisionId
    }, signal);
    this.validateWriteResponse(result, current.token, current.revisionId);
    return this.writeResult("patch", current.token, result.revision_id, signal);
  }
  async listSpaces(signal) {
    const data = await this.run({ id: "wiki.spaceList" }, signal);
    const parsed = parseContract(spaceListSchema, data);
    return parsed.spaces.map((space) => ({ spaceId: space.space_id, name: space.name }));
  }
  async listNodes(input, signal) {
    const data = await this.run({
      id: "wiki.nodeList",
      spaceId: input.spaceId,
      ...input.parentNodeToken ? { parentNodeToken: input.parentNodeToken } : {}
    }, signal);
    const parsed = parseContract(nodeListSchema, data);
    return parsed.nodes.map((node) => ({
      nodeToken: node.node_token,
      title: node.title,
      objType: node.obj_type
    }));
  }
  async getNode(input, signal) {
    const data = await this.run({
      id: "wiki.nodeGet",
      nodeToken: input.nodeToken
    }, signal);
    const node = parseContract(nodeSchema, data);
    return {
      nodeToken: node.node_token,
      objToken: node.obj_token,
      objType: node.obj_type,
      title: node.title
    };
  }
};
export {
  LarkKnowledgeService,
  validateKnowledgeCommandResult
};
