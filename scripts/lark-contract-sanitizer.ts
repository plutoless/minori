import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export type StringClass = 'enum' | 'id' | 'url' | 'text' | 'unknown';
export type SanitizationResult = {
  value: unknown;
  unclassifiedStringFields: string[];
};

const SAFE_ENUMS = new Set([
  'normal', 'unified', 'unknown', 'user', 'bot', 'none', 'ready', 'unavailable',
  'verified', 'needs_review', 'not_exercised_by_policy', 'failed',
  'DOC', 'DOCX', 'WIKI', 'feishu', 'lark', 'larksuite',
]);
const PLACEHOLDERS = new Set([
  '<redacted-id>', '<redacted-url>', '<redacted-text>', '<redacted-string>',
]);

function classify(key: string, value: string): StringClass {
  if (SAFE_ENUMS.has(value)) return 'enum';
  if (/(?:^|_)(?:id|ids|token|tokens|code|revision_id)$/u.test(key)) return 'id';
  if (/(?:url|uri|link)$/u.test(key)) return 'url';
  if (/(?:title|name|body|content|description|message|topic|display_info|markdown|text)$/u
    .test(key)) return 'text';
  return 'unknown';
}

export function sanitizeCapture(value: unknown): SanitizationResult {
  const unclassifiedStringFields: string[] = [];
  const visit = (current: unknown, path: string, key = ''): unknown => {
    if (typeof current === 'string') {
      if (current.length === 0) return current;
      const stringClass = classify(key, current);
      if (stringClass === 'enum') return current;
      if (stringClass === 'id') return '<redacted-id>';
      if (stringClass === 'url') return '<redacted-url>';
      if (stringClass === 'text') return '<redacted-text>';
      unclassifiedStringFields.push(path);
      return '<redacted-string>';
    }
    if (Array.isArray(current)) {
      return current.map((item, index) => visit(item, `${path}[${index}]`, key));
    }
    if (current !== null && typeof current === 'object') {
      return Object.fromEntries(Object.entries(current as Record<string, unknown>)
        .map(([childKey, child]) => [
          childKey,
          visit(child, `${path}.${childKey}`, childKey),
        ]));
    }
    return current;
  };
  return { value: visit(value, '$'), unclassifiedStringFields };
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(strings);
  }
  return [];
}

export async function scanForbiddenResidue(paths: string[]) {
  for (const path of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('lark_contract_residue_detected');
    }
    for (const value of strings(parsed)) {
      if (value.length === 0 || PLACEHOLDERS.has(value) || SAFE_ENUMS.has(value)) continue;
      throw new Error('lark_contract_residue_detected');
    }
  }
}

export async function validateTranscriptArtifact(
  root: string,
  relativePath: string,
  maxBytes: number,
) {
  try {
    if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) {
      throw new Error();
    }
    const rootReal = await realpath(root);
    const candidate = resolve(rootReal, relativePath);
    const candidateRelative = relative(rootReal, candidate);
    if (candidateRelative.startsWith('..') || isAbsolute(candidateRelative)) throw new Error();
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes) {
      throw new Error();
    }
    const candidateReal = await realpath(candidate);
    const realRelative = relative(rootReal, candidateReal);
    if (realRelative.startsWith('..') || isAbsolute(realRelative)) throw new Error();
    return { byteCount: info.size };
  } catch {
    throw new Error('lark_contract_transcript_invalid');
  }
}
