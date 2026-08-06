import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../../src/runtime/logger.js';

describe('createLogger', () => {
  it('redacts credentials and connection details from structured logs', () => {
    const lines: string[] = [];
    const destination: DestinationStream = {
      write(chunk) {
        lines.push(String(chunk));
        return true;
      },
    };
    const logger = createLogger('info', destination);

    logger.info({
      appSecret: 'feishu-secret',
      openaiApiKey: 'openai-secret',
      databaseUrl: 'postgres://user:password@example.com/minori',
      request: {
        headers: {
          authorization: 'Bearer secret',
          cookie: 'session=access-token',
        },
        oauth: {
          authorizationUrl: 'https://example.com/oauth?code=secret',
        },
      },
      error: new Error('postgres://user:nested-password@example.com/minori'),
    }, 'configuration loaded');
    logger.child({ databaseUrl: 'postgres://child:child-password@example.com/minori' })
      .info('child logger ready');

    const output = lines.join('');
    expect(output).toContain('configuration loaded');
    expect(output).toContain('[Redacted]');
    expect(output).not.toMatch(/feishu-secret|openai-secret|password|Bearer secret|code=secret|access-token/);
  });
});
