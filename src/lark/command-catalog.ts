export type LarkCommand =
  | { id: 'auth.status' }
  | { id: 'drive.search'; query: string; spaceIds?: string[] }
  | { id: 'docs.fetch'; doc: string }
  | { id: 'docs.create'; title: string; content: string; parentToken?: string }
  | { id: 'docs.append'; doc: string; content: string; revisionId: number }
  | { id: 'docs.patch'; doc: string; pattern: string; content: string; revisionId: number }
  | { id: 'wiki.spaceList' }
  | { id: 'wiki.nodeList'; spaceId: string; parentNodeToken?: string }
  | { id: 'wiki.nodeGet'; nodeToken: string };

export type LarkInvocation = {
  args: string[];
  stdin?: string;
};

const USER_JSON_ARGS = ['--format', 'json', '--as', 'user'] as const;

export function buildInvocation(command: LarkCommand): LarkInvocation {
  switch (command.id) {
    case 'auth.status':
      return { args: ['auth', 'status', '--json'] };
    case 'drive.search':
      return {
        args: [
          'drive', '+search', '--query', command.query,
          ...(command.spaceIds?.length ? ['--space-ids', command.spaceIds.join(',')] : []),
          ...USER_JSON_ARGS,
        ],
      };
    case 'docs.fetch':
      return {
        args: [
          'docs', '+fetch', '--doc', command.doc, '--doc-format', 'markdown',
          ...USER_JSON_ARGS,
        ],
      };
    case 'docs.create':
      return {
        args: [
          'docs', '+create', '--title', command.title,
          ...(command.parentToken ? ['--parent-token', command.parentToken] : []),
          '--doc-format', 'markdown', '--content', '-', ...USER_JSON_ARGS,
        ],
        stdin: command.content,
      };
    case 'docs.append':
      return {
        args: [
          'docs', '+update', '--doc', command.doc, '--command', 'append',
          '--revision-id', String(command.revisionId), '--doc-format', 'markdown', '--content', '-',
          ...USER_JSON_ARGS,
        ],
        stdin: command.content,
      };
    case 'docs.patch':
      return {
        args: [
          'docs', '+update', '--doc', command.doc, '--command', 'str_replace',
          '--pattern', command.pattern, '--revision-id', String(command.revisionId),
          '--doc-format', 'markdown', '--content', '-', ...USER_JSON_ARGS,
        ],
        stdin: command.content,
      };
    case 'wiki.spaceList':
      return { args: ['wiki', '+space-list', ...USER_JSON_ARGS] };
    case 'wiki.nodeList':
      return {
        args: [
          'wiki', '+node-list', '--space-id', command.spaceId,
          ...(command.parentNodeToken
            ? ['--parent-node-token', command.parentNodeToken]
            : []),
          ...USER_JSON_ARGS,
        ],
      };
    case 'wiki.nodeGet':
      return {
        args: ['wiki', '+node-get', '--node-token', command.nodeToken, ...USER_JSON_ARGS],
      };
  }
}
