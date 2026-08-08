import { describe, expect, it } from 'vitest';
import { SourceRegistry } from '../../src/agent/sources.js';

describe('SourceRegistry', () => {
  it('returns every authentic fetched source even when the answer uses natural prose', () => {
    const sources = new SourceRegistry();
    sources.register({ title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' });

    expect(sources.finalize('Natural answer')).toEqual({
      text: 'Natural answer',
      sources: [{ id: 1, title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' }],
    });
  });

  it('removes unread numeric markers while preserving authentic markers and prose', () => {
    const sources = new SourceRegistry();
    sources.register({ title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' });

    expect(sources.finalize('Supported [1], unsupported [7], answer intact.')).toEqual({
      text: 'Supported [1], unsupported, answer intact.',
      sources: [{ id: 1, title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' }],
    });
  });

  it('removes unread markers attached directly to English or Chinese prose', () => {
    expect(new SourceRegistry().finalize('Conclusion[7]. 结论[8]。').text)
      .toBe('Conclusion. 结论。');
  });

  it('returns an unchanged source-free answer without any declaration marker', () => {
    expect(new SourceRegistry().finalize('Direct general assistance.')).toEqual({
      text: 'Direct general assistance.', sources: [],
    });
  });

  it('deduplicates fetched documents by URL in registration order', () => {
    const sources = new SourceRegistry();
    expect(sources.register({ title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' }).id)
      .toBe(1);
    expect(sources.register({ title: 'Duplicate', url: 'https://example.feishu.cn/docx/1' }).id)
      .toBe(1);
    sources.register({ title: 'Notes', url: 'https://example.feishu.cn/docx/2' });

    expect(sources.finalize('Combined answer.').sources).toEqual([
      { id: 1, title: 'Roadmap', url: 'https://example.feishu.cn/docx/1' },
      { id: 2, title: 'Notes', url: 'https://example.feishu.cn/docx/2' },
    ]);
  });

  it('normalizes metadata before assigning IDs and deduplicating canonical URLs', () => {
    const sources = new SourceRegistry();
    expect(sources.register({
      title: '  Roadmap\n draft ', url: 'https://example.com/a/../doc',
    })).toEqual({ id: 1, title: 'Roadmap draft', url: 'https://example.com/doc' });
    expect(sources.register({
      title: 'Duplicate', url: 'https://example.com/doc',
    }).id).toBe(1);

    expect(sources.finalize('See the roadmap [1].')).toEqual({
      text: 'See the roadmap [1].',
      sources: [{ id: 1, title: 'Roadmap draft', url: 'https://example.com/doc' }],
    });
  });

  it('does not confuse code indices, footnotes, links, or quotes with source markers', () => {
    const sources = new SourceRegistry();
    expect(sources.finalize([
      'Use `items[9]` and see [1](https://example.com).',
      '> The user wrote [2].',
      '[^3]: a footnote',
    ].join('\n')).text).toBe([
      'Use `items[9]` and see [1](https://example.com).',
      '> The user wrote [2].',
      '[^3]: a footnote',
    ].join('\n'));
  });

  it('preserves numeric bracket indexing inside tilde-fenced CommonMark code', () => {
    const answer = [
      '~~~ts',
      'const item = values[7];',
      '~~~',
      'Unread source [8].',
    ].join('\n');

    expect(new SourceRegistry().finalize(answer).text).toBe([
      '~~~ts',
      'const item = values[7];',
      '~~~',
      'Unread source.',
    ].join('\n'));
  });

  it('preserves numeric bracket indexing inside space- and tab-indented code', () => {
    const answer = [
      '    const first = values[7];',
      '\tconst second = values[8];',
      'Unread source [9].',
    ].join('\n');

    expect(new SourceRegistry().finalize(answer).text).toBe([
      '    const first = values[7];',
      '\tconst second = values[8];',
      'Unread source.',
    ].join('\n'));
  });
});
