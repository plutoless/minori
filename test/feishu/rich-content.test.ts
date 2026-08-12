import { describe, expect, it } from 'vitest';
import { neutralizeMarkdownImages, richPostContent } from '../../src/feishu/rich-content.js';

describe('Feishu rich content', () => {
  it('wraps Markdown in exactly one md element', () => {
    expect(JSON.parse(richPostContent('# 标题\n\n- **项目**\n- [来源](https://example.com)')))
      .toEqual({
        zh_cn: {
          title: '',
          content: [[{
            tag: 'md',
            text: '# 标题\n\n- **项目**\n- [来源](https://example.com)',
          }]],
        },
      });
  });

  it('turns Markdown images into labeled links without changing ordinary links', () => {
    const markdown = '![架构图](https://img.example/diagram.png) [文档](https://example.com/doc)';
    expect(neutralizeMarkdownImages(markdown)).toBe(
      '[图片：架构图](https://img.example/diagram.png) [文档](https://example.com/doc)',
    );
  });

  it('uses a stable label for empty image alt text', () => {
    expect(neutralizeMarkdownImages('![](https://img.example/a.png)'))
      .toBe('[图片](https://img.example/a.png)');
  });

  it('turns reference-style images into ordinary labeled links', () => {
    const markdown = [
      '请看 ![架构\\]图][asset]。',
      '',
      '[asset]: https://img.example/diagram.png "架构"',
    ].join('\n');

    expect(neutralizeMarkdownImages(markdown)).toBe([
      '请看 [图片：架构\\]图](https://img.example/diagram.png)。',
      '',
      '[asset]: https://img.example/diagram.png "架构"',
    ].join('\n'));
  });

  it('de-images unresolved reference syntax without inventing a URL', () => {
    expect(neutralizeMarkdownImages('![未知图][missing]'))
      .toBe('[图片：未知图]');
  });
});
