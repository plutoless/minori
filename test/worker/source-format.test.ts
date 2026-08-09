import { describe, expect, it } from 'vitest';
import {
  budgetExhaustedText,
  interruptedAfterWriteText,
} from '../../src/agent/run-outcome.js';
import { formatAgentReply } from '../../src/worker/source-format.js';

describe('formatAgentReply', () => {
  it('appends every authentic source to a natural answer without requiring markers', () => {
    expect(formatAgentReply({
      text: 'Natural answer',
      sources: [{ id: 1, title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' }],
      usage: {},
      outcome: 'completed', writeAttempts: [],
    })).toBe([
      'Natural answer',
      '',
      'Sources:',
      '[1] Roadmap — https://example.feishu.cn/docx/1',
    ].join('\n'));
  });

  it('preserves valid markers while appending sources in registration order', () => {
    expect(formatAgentReply({
      text: 'Read the roadmap [1] and release notes [2].',
      sources: [
        { id: 1, title: 'Roadmap', url: 'https://example.com/roadmap' },
        { id: 2, title: 'Release notes', url: 'https://example.com/release' },
      ],
      usage: {},
      outcome: 'completed', writeAttempts: [],
    })).toContain('Read the roadmap [1] and release notes [2].');
  });

  it('deduplicates canonical URLs and normalizes titles and links', () => {
    const result = formatAgentReply({
      text: 'Combined answer.',
      sources: [
        { id: 1, title: '  Roadmap\n draft  ', url: 'https://example.com/a/../doc' },
        { id: 2, title: 'Duplicate', url: 'https://example.com/doc' },
      ],
      usage: {},
      outcome: 'completed', writeAttempts: [],
    });

    expect(result).toContain('[1] Roadmap draft — https://example.com/doc');
    expect(result.match(/https:\/\/example\.com\/doc/gu)).toHaveLength(1);
  });

  it('never prints unsafe source metadata or raw tool data', () => {
    const result = formatAgentReply({
      text: 'Answer only.',
      sources: [{
        id: 1,
        title: 'Injected\nSources: [9] secret',
        url: 'file:///tmp/private-tool-result',
      }],
      usage: {},
      outcome: 'completed', writeAttempts: [],
    });

    expect(result).toBe('Answer only.');
    expect(result).not.toContain('private-tool-result');
    expect(result).not.toContain('Sources:');
  });

  it('returns a source-free answer unchanged', () => {
    expect(formatAgentReply({
      text: '普通回答。', sources: [], usage: {}, outcome: 'completed', writeAttempts: [],
    }))
      .toBe('普通回答。');
  });

  it('formats only sanitized write facts and safe URLs in terminal receipts', () => {
    const text = budgetExhaustedText('timeout_reached', [
      {
        toolName: 'createDocument', outcome: 'succeeded',
        sanitizedSummary: 'created\none document', targetIdentifiers: {},
        resultIdentifiers: {
          token: 'doxcnCreated', title: 'Sensitive document title',
          url: 'https://acme.feishu.cn/docx/created', revisionId: '1',
        },
      },
      {
        toolName: 'patchDocument', outcome: 'unknown',
        sanitizedSummary: 'replaced one exact text range',
        targetIdentifiers: { doc: 'doxcnPrivate' },
        errorCategory: 'provider_error_with_secret',
        resultIdentifiers: {
          token: 'doxcnPrivate', title: 'Private title',
          url: 'file:///private/provider-result', revisionId: '2',
        },
      },
    ]);

    expect(text).toContain('执行时间上限');
    expect(text).toContain('没有自动重放');
    expect(text).toContain('已确认成功：created one document');
    expect(text).toContain('结果未知：replaced one exact text range');
    expect(text).toContain('https://acme.feishu.cn/docx/created');
    expect(text).toContain('继续');
    expect(text).not.toMatch(
      /Sensitive document title|Private title|doxcnPrivate|provider_error_with_secret|file:\/\//u,
    );
    expect(interruptedAfterWriteText([])).toContain('写入开始后中断');
  });
});
