import { describe, expect, it } from 'vitest';
import { formatAgentReply } from '../../src/worker/source-format.js';

describe('formatAgentReply', () => {
  it('appends every authentic source to a natural answer without requiring markers', () => {
    expect(formatAgentReply({
      text: 'Natural answer',
      sources: [{ id: 1, title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' }],
      usage: {},
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
    });

    expect(result).toBe('Answer only.');
    expect(result).not.toContain('private-tool-result');
    expect(result).not.toContain('Sources:');
  });

  it('returns a source-free answer unchanged', () => {
    expect(formatAgentReply({ text: '普通回答。', sources: [], usage: {} }))
      .toBe('普通回答。');
  });
});
