export type LarkCommand =
  | { id: 'auth.status' }
  | { id: 'contact.searchUser'; query: string; pageSize: number }
  | {
      id: 'vc.search';
      query?: string;
      start?: string;
      end?: string;
      organizerIds?: string[];
      participantIds?: string[];
      pageSize: number;
      pageToken?: string;
    }
  | { id: 'vc.detail'; meetingIds: string[] }
  | { id: 'note.detail'; noteId: string }
  | { id: 'note.transcript'; noteId: string; workDir: string }
  | {
      id: 'minutes.search';
      query?: string;
      start?: string;
      end?: string;
      ownerIds?: string[];
      participantIds?: string[];
      pageSize: number;
      pageToken?: string;
    }
  | {
      id: 'minutes.detail';
      minuteTokens: string[];
      artifact: 'summary' | 'todo' | 'chapter';
    }
  | {
      id: 'minutes.detail';
      minuteTokens: string[];
      artifact: 'transcript';
      workDir: string;
    }
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
  cwd?: string;
};

const USER_JSON_ARGS = ['--format', 'json', '--as', 'user'] as const;

export function buildInvocation(command: LarkCommand): LarkInvocation {
  switch (command.id) {
    case 'auth.status':
      return { args: ['auth', 'status', '--json', '--verify'] };
    case 'contact.searchUser':
      return {
        args: [
          'contact', '+search-user', '--query', command.query,
          '--page-size', String(command.pageSize), ...USER_JSON_ARGS,
        ],
      };
    case 'vc.search':
      return {
        args: [
          'vc', '+search',
          ...(command.query ? ['--query', command.query] : []),
          ...(command.start ? ['--start', command.start] : []),
          ...(command.end ? ['--end', command.end] : []),
          ...(command.organizerIds?.length
            ? ['--organizer-ids', command.organizerIds.join(',')]
            : []),
          ...(command.participantIds?.length
            ? ['--participant-ids', command.participantIds.join(',')]
            : []),
          '--page-size', String(command.pageSize),
          ...(command.pageToken ? ['--page-token', command.pageToken] : []),
          ...USER_JSON_ARGS,
        ],
      };
    case 'vc.detail':
      return {
        args: [
          'vc', '+detail', '--meeting-ids', command.meetingIds.join(','), ...USER_JSON_ARGS,
        ],
      };
    case 'note.detail':
      return {
        args: ['note', '+detail', '--note-id', command.noteId, ...USER_JSON_ARGS],
      };
    case 'note.transcript':
      return {
        args: [
          'note', '+transcript', '--note-id', command.noteId,
          '--output', 'unified_transcript.md', '--transcript-format', 'markdown',
          ...USER_JSON_ARGS,
        ],
        cwd: command.workDir,
      };
    case 'minutes.search':
      return {
        args: [
          'minutes', '+search',
          ...(command.query ? ['--query', command.query] : []),
          ...(command.start ? ['--start', command.start] : []),
          ...(command.end ? ['--end', command.end] : []),
          ...(command.ownerIds?.length ? ['--owner-ids', command.ownerIds.join(',')] : []),
          ...(command.participantIds?.length
            ? ['--participant-ids', command.participantIds.join(',')]
            : []),
          '--page-size', String(command.pageSize),
          ...(command.pageToken ? ['--page-token', command.pageToken] : []),
          ...USER_JSON_ARGS,
        ],
      };
    case 'minutes.detail': {
      const artifactFlag = `--${command.artifact}`;
      return {
        args: [
          'minutes', '+detail', '--minute-tokens', command.minuteTokens.join(','), artifactFlag,
          ...(command.artifact === 'transcript' ? ['--output-dir', '.'] : []),
          ...USER_JSON_ARGS,
        ],
        ...(command.artifact === 'transcript' ? { cwd: command.workDir } : {}),
      };
    }
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
