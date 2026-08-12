const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;

export function neutralizeMarkdownImages(markdown: string): string {
  return markdown.replace(MARKDOWN_IMAGE, (_match, rawAlt: string, url: string) => {
    const alt = rawAlt.trim();
    return `[${alt ? `图片：${alt}` : '图片'}](${url})`;
  });
}

export function richPostContent(markdown: string): string {
  return JSON.stringify({
    zh_cn: {
      title: '',
      content: [[{ tag: 'md', text: neutralizeMarkdownImages(markdown) }]],
    },
  });
}
