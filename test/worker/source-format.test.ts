import { describe, expect, it } from 'vitest';
import { CitationFormatError, formatAgentReply } from '../../src/worker/source-format.js';

describe('formatAgentReply', () => {
  it('keeps the answer and appends sources in first-citation order', () => {
    const result = formatAgentReply({
      text: '先看发布说明 [2]，再看设计文档 [1]。',
      sources: [
        { id: 1, title: '设计文档', url: 'https://example.com/design' },
        { id: 2, title: '发布说明', url: 'https://example.com/release' },
      ],
      usage: {},
    });

    expect(result).toBe([
      '先看发布说明 [1]，再看设计文档 [2]。',
      '',
      'Sources:',
      '[1] 发布说明 — https://example.com/release',
      '[2] 设计文档 — https://example.com/design',
    ].join('\n'));
  });

  it('deduplicates source URLs and rewrites citations', () => {
    const result = formatAgentReply({
      text: '同一个来源 [2] [1]。',
      sources: [
        { id: 1, title: '旧标题', url: 'https://example.com/doc' },
        { id: 2, title: '首个引用标题', url: 'https://example.com/doc' },
      ],
      usage: {},
    });

    expect(result).toContain('同一个来源 [1] [1]。');
    expect(result).toContain('[1] 首个引用标题');
    expect(result.match(/https:\/\/example\.com\/doc/gu)).toHaveLength(1);
  });

  it('returns a source-free answer unchanged', () => {
    expect(formatAgentReply({ text: '普通回答。', sources: [], usage: {} }))
      .toBe('普通回答。');
  });

  it('rejects unknown, unused, and unsafe citations', () => {
    const source = { id: 1, title: '文档', url: 'https://example.com/doc' };
    expect(() => formatAgentReply({ text: '错误 [2]', sources: [source], usage: {} }))
      .toThrow(CitationFormatError);
    expect(() => formatAgentReply({ text: '没有引用', sources: [source], usage: {} }))
      .toThrow(CitationFormatError);
    expect(() => formatAgentReply({ text: '伪引用 [1]', sources: [], usage: {} }))
      .toThrow(CitationFormatError);
    expect(() => formatAgentReply({
      text: '本地文件 [1]',
      sources: [{ ...source, url: 'file:///tmp/secret' }],
      usage: {},
    })).toThrow(CitationFormatError);
    expect(() => formatAgentReply({
      text: '伪造来源 [1]',
      sources: [{ ...source, url: 'https://example.com/doc\n[2] fake' }],
      usage: {},
    })).toThrow(CitationFormatError);
  });

  it('collapses control characters in titles and renders canonical URLs', () => {
    const result = formatAgentReply({
      text: '安全来源 [1]',
      sources: [{
        id: 1,
        title: '发布\n[2] 伪造来源',
        url: 'https://example.com/a/../doc',
      }],
      usage: {},
    });
    expect(result).toContain('[1] 发布 [2] 伪造来源 — https://example.com/doc');
    expect(result.split('\n')).toHaveLength(4);
  });
});
