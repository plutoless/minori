import { z } from 'zod';

function decode<TSchema extends z.ZodType>(schema: TSchema, data: unknown) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error('lark_contract_decode_failed');
  return parsed.data;
}

export const authStatusSchema = z.object({
  appId: z.string(),
  brand: z.string(),
  defaultAs: z.string(),
  identity: z.enum(['user', 'bot', 'none']),
  identities: z.object({
    user: z.object({ status: z.string(), available: z.boolean() }).passthrough(),
    bot: z.object({ status: z.string(), available: z.boolean() }).passthrough(),
  }).passthrough(),
}).passthrough();

export const contactEnvelopeSchema = z.object({ users: z.array(z.unknown()) }).passthrough();
export const contactRowSchema = z.object({
  open_id: z.string().min(1), localized_name: z.string().min(1),
}).passthrough();
export const meetingSearchEnvelopeSchema = z.object({
  items: z.array(z.unknown()), has_more: z.boolean().optional(), page_token: z.string().optional(),
}).passthrough();
export const meetingDetailEnvelopeSchema = z.object({ meetings: z.array(z.unknown()) }).passthrough();
export const meetingRowSchema = z.object({
  id: z.string().trim().min(1),
  display_info: z.string().optional(),
  meta_data: z.object({
    app_link: z.unknown().optional(), description: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();
export const meetingDetailRowSchema = z.object({
  meeting_id: z.string().min(1), topic: z.string().min(1),
}).passthrough();
export const minuteRowSchema = z.object({ title: z.string().min(1) }).passthrough();
export const noteDetailSchema = z.object({
  note: z.object({
    note_display_type: z.enum(['normal', 'unified', 'unknown']),
    note_doc_token: z.string().optional(),
    verbatim_doc_token: z.string().optional(),
  }).passthrough(),
}).passthrough();
export const minuteDetailEnvelopeSchema = z.object({ minutes: z.array(z.unknown()) }).passthrough();
export const minuteDetailRowSchema = z.object({
  minute_token: z.string().min(1),
  title: z.string().optional(),
  note_id: z.string().optional(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
}).passthrough();
export const transcriptResponseSchema = z.object({ transcript_file: z.string().min(1) }).passthrough();

export const driveSearchSchema = z.object({ results: z.array(z.unknown()) }).passthrough();
export const driveSearchRowSchema = z.object({ entity_type: z.string().min(1) }).passthrough();
export const knowledgeDocumentSchema = z.object({
  document: z.object({
    document_id: z.string(), revision_id: z.number().int(), content: z.string(),
    title: z.string().optional(), url: z.string().optional(),
  }).passthrough(),
}).passthrough();
export const knowledgeWriteSchema = z.object({
  document: z.object({
    document_id: z.string().optional(), revision_id: z.number().int(),
  }).passthrough(),
}).passthrough();
export const spaceListSchema = z.object({
  spaces: z.array(z.object({ space_id: z.string(), name: z.string() }).passthrough()),
}).passthrough();
export const nodeListSchema = z.object({
  nodes: z.array(z.object({
    node_token: z.string(), title: z.string(), obj_type: z.string(),
  }).passthrough()),
}).passthrough();
export const nodeSchema = z.object({
  node_token: z.string(), obj_token: z.string(), obj_type: z.string(), title: z.string(),
}).passthrough();

export const decodeAuthStatus = (data: unknown) => decode(authStatusSchema, data);
export const decodeContactEnvelope = (data: unknown) => decode(contactEnvelopeSchema, data);
export const decodeMeetingSearchEnvelope = (data: unknown) => decode(meetingSearchEnvelopeSchema, data);
export const decodeMeetingDetailEnvelope = (data: unknown) => decode(meetingDetailEnvelopeSchema, data);
export const decodeNoteDetail = (data: unknown) => decode(noteDetailSchema, data);
export const decodeMinuteDetailEnvelope = (data: unknown) => decode(minuteDetailEnvelopeSchema, data);
export const decodeTranscriptResponse = (data: unknown) => decode(transcriptResponseSchema, data);
export const decodeDriveSearch = (data: unknown) => decode(driveSearchSchema, data);
export const decodeKnowledgeDocument = (data: unknown) => decode(knowledgeDocumentSchema, data);
export const decodeKnowledgeWrite = (data: unknown) => decode(knowledgeWriteSchema, data);
export const decodeSpaceList = (data: unknown) => decode(spaceListSchema, data);
export const decodeNodeList = (data: unknown) => decode(nodeListSchema, data);
export const decodeNode = (data: unknown) => decode(nodeSchema, data);
