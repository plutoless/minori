import { describe, expect, it } from 'vitest';
import {
  CitationContractError, GENERAL_ANSWER_MARKER, SourceRegistry,
} from '../../src/agent/sources.js';

describe('SourceRegistry', () => {
  it('resolves cited sources and rejects broken citation contracts', () => {
    const sources = new SourceRegistry();
    sources.register({ title: 'Roadmap', url: 'https://acme.feishu.cn/docx/roadmap' });

    expect(sources.finalize('The launch is Friday [1].')).toEqual({
      text: 'The launch is Friday [1].',
      sources: [{ id: 1, title: 'Roadmap', url: 'https://acme.feishu.cn/docx/roadmap' }],
    });
    expect(() => sources.finalize('The launch is Friday.')).toThrow(CitationContractError);
    expect(() => sources.finalize('The launch is Friday [2].')).toThrow(CitationContractError);
  });

  it('rejects fetched sources that the answer never cites', () => {
    const sources = new SourceRegistry();
    sources.register({ title: 'One', url: 'https://acme.feishu.cn/docx/one' });
    sources.register({ title: 'Two', url: 'https://acme.feishu.cn/docx/two' });

    expect(() => sources.finalize('Only the first source is used [1].'))
      .toThrow(CitationContractError);
  });

  it('normalizes source numbering by first textual use', () => {
    const sources = new SourceRegistry();
    sources.register({ title: 'One', url: 'https://acme.feishu.cn/docx/one' });
    sources.register({ title: 'Two', url: 'https://acme.feishu.cn/docx/two' });

    expect(sources.finalize('Second evidence [2]. First evidence [1].')).toEqual({
      text: 'Second evidence [1]. First evidence [2].',
      sources: [
        { id: 1, title: 'Two', url: 'https://acme.feishu.cn/docx/two' },
        { id: 2, title: 'One', url: 'https://acme.feishu.cn/docx/one' },
      ],
    });
    expect(sources.finalize('```\n😀\n```\nSecond [2]. First [1].').text)
      .toBe('```\n😀\n```\nSecond [1]. First [2].');
  });

  it('requires an explicit general-answer declaration when no evidence was read', () => {
    const sources = new SourceRegistry();
    expect(() => sources.finalize('The team launch is Friday.')).toThrow(CitationContractError);
    expect(sources.finalize(`Shorter version.\n${GENERAL_ANSWER_MARKER}`)).toEqual({
      text: 'Shorter version.', sources: [],
    });
  });

  it('rejects citations detached into a Sources label instead of the factual paragraph', () => {
    const sources = new SourceRegistry();
    sources.register({ title: 'One', url: 'https://acme.feishu.cn/docx/one' });
    expect(() => sources.finalize('The launch is Friday.\nSources: [1]'))
      .toThrow(CitationContractError);
  });

  it('does not confuse code indices, footnotes, links, or quotes with citations', () => {
    const general = new SourceRegistry();
    expect(general.finalize([
      'Use `items[0]` and see [1](https://example.com).',
      '> The user wrote [2].',
      '[^3]: a footnote',
      GENERAL_ANSWER_MARKER,
    ].join('\n'))).toMatchObject({ sources: [] });

    const sourced = new SourceRegistry();
    sourced.register({ title: 'API', url: 'https://acme.feishu.cn/docx/api' });
    expect(sourced.finalize('The example `items[9]` is documented [1].').text)
      .toBe('The example `items[9]` is documented [1].');
  });
});
