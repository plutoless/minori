const INLINE_MARKDOWN_IMAGE = /!\[((?:\\.|[^\]\\])*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu;
const REFERENCE_MARKDOWN_IMAGE = /!\[((?:\\.|[^\]\\])*)\]\[((?:\\.|[^\]\\])*)\]/gu;
const SHORTCUT_MARKDOWN_IMAGE = /!\[((?:\\.|[^\]\\])*)\](?![[(])/gu;
const REFERENCE_DEFINITION = /^ {0,3}\[((?:\\.|[^\]\\])*)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?[ \t]*$/gmu;

function imageLabel(rawAlt: string): string {
  const alt = rawAlt.trim();
  return alt ? `图片：${alt}` : '图片';
}

function normalizeReference(rawReference: string): string {
  return rawReference
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, '$1')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLocaleLowerCase('en-US');
}

export function neutralizeMarkdownImages(markdown: string): string {
  const definitions = new Map<string, string>();
  for (const match of markdown.matchAll(REFERENCE_DEFINITION)) {
    const reference = match[1];
    const url = match[2] ?? match[3];
    if (reference !== undefined && url !== undefined) {
      definitions.set(normalizeReference(reference), url);
    }
  }

  return markdown
    .replace(
      REFERENCE_MARKDOWN_IMAGE,
      (_match, rawAlt: string, rawReference: string) => {
        const reference = rawReference || rawAlt;
        const url = definitions.get(normalizeReference(reference));
        const label = imageLabel(rawAlt);
        return url ? `[${label}](${url})` : `[${label}]`;
      },
    )
    .replace(
      INLINE_MARKDOWN_IMAGE,
      (_match, rawAlt: string, url: string) => `[${imageLabel(rawAlt)}](${url})`,
    )
    .replace(SHORTCUT_MARKDOWN_IMAGE, (_match, rawAlt: string) => {
      const url = definitions.get(normalizeReference(rawAlt));
      const label = imageLabel(rawAlt);
      return url ? `[${label}](${url})` : `[${label}]`;
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
